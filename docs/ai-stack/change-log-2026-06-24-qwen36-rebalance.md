# Qwen3.6 GPU Rebalance Change Log

Date: 2026-06-23 to 2026-06-24 CST

## Goal

Rebalance the AI server so that:

- GPU0 + GPU1 run one Qwen3.6 FP8 service for LLM and light multimodal workloads.
- GPU2 runs the secondary ComfyUI instance and remains the speech service environment.
- GPU3 runs the primary ComfyUI instance.
- The old Qwen2.5-VL endpoint is disabled.

## Starting Point

Before the rebalance:

| GPU | Service | Model |
| --- | --- | --- |
| GPU0 | `ai-llm` | `Qwen/Qwen3.6-35B-A3B-FP8`, text-only, TP=1 |
| GPU1 | `ai-vlm` | `Qwen/Qwen2.5-VL-7B-Instruct` |
| GPU2 | `ai-speech` | `iic/SenseVoiceSmall` |
| GPU3 | `ai-comfy` | ComfyUI |

The old LLM service used `--language-model-only`, so Qwen3.6 did not accept image input.

## Changes Applied

1. Backed up current scripts and systemd units to:

   ```text
   /home/ubuntu/ai-stack/backups/rebalance-20260623-225506
   ```

2. Disabled the old VLM endpoint:

   ```bash
   sudo systemctl stop ai-vlm.service
   sudo systemctl disable ai-vlm.service
   ```

3. Updated `/home/ubuntu/ai-stack/bin/run-llm.sh`:

   - `CUDA_VISIBLE_DEVICES=0,1`
   - `--tensor-parallel-size 2`
   - Removed `--language-model-only`
   - Kept `VLLM_USE_FLASHINFER_SAMPLER=0`
   - Added `--enforce-eager`
   - Added `--disable-custom-all-reduce`
   - Set `--max-model-len 131072`

4. Added a second ComfyUI launcher:

   ```text
   /home/ubuntu/ai-stack/bin/run-comfy-gpu2.sh
   ```

   It binds ComfyUI to GPU2 and port `8189`.

5. Added and enabled a second ComfyUI systemd unit:

   ```text
   /etc/systemd/system/ai-comfy-gpu2.service
   ```

6. Restarted and validated services.

## Failed / Adjusted Attempts

These attempts were useful evidence and should not be repeated blindly:

- `65K + TP=2 + multimodal + CUDA graph` loaded weights and allocated KV cache but stalled before the API server started.
- `65K + TP=2 + multimodal + --enforce-eager` also stalled.
- Removing prefix caching did not fix the stall.
- `32K + TP=2 + --enforce-eager` still stalled until `--disable-custom-all-reduce` was added.
- After adding `--disable-custom-all-reduce`, `32K` started successfully.
- `128K` then started successfully with the same stable flags.

## Stable Qwen3.6 Flags

```bash
export CUDA_VISIBLE_DEVICES=0,1
export VLLM_USE_FLASHINFER_SAMPLER=0

vllm serve Qwen/Qwen3.6-35B-A3B-FP8 \
  --served-model-name qwen3.6-35b-a3b \
  --tensor-parallel-size 2 \
  --max-model-len 131072 \
  --max-num-seqs 4 \
  --max-num-batched-tokens 8192 \
  --gpu-memory-utilization 0.86 \
  --enforce-eager \
  --disable-custom-all-reduce \
  --reasoning-parser qwen3
```

## Verification Evidence

Final checks passed:

```text
8000 /health -> 200
8000 /v1/models -> qwen3.6-35b-a3b
text smoke -> 2
image smoke -> 白色
8002 /health -> 200
8188 / -> 200
8189 / -> 200
8001 -> down as expected
```

## Remaining Risks

- 128K startup and smoke test passed, but high-concurrency long-context performance has not been benchmarked.
- `--enforce-eager` is more stable here but may reduce throughput compared with CUDA graph.
- GPU2 hosts both the secondary ComfyUI process and the speech service environment. Heavy ComfyUI jobs can affect speech latency.
- ComfyUI model loading is lazy. GPU2/GPU3 look mostly empty at idle and may consume much more memory during generation.
