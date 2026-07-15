# AI Server Current Deployment

Last verified: 2026-06-30 CST

This document records the current deployment on the AI server reached through:

```bash
ssh -p 2222 admin@60.205.213.254
ssh ubuntu@192.168.100.12
```

Do not write passwords, API keys, or private keys into this repository.

## Hardware

Runtime host:

- Hostname: `ubuntu-NF5468-M7-A0-R0-00`
- OS: Ubuntu 24.04.4 LTS
- Kernel: `6.17.0-35-generic`
- GPUs: 4 x NVIDIA RTX 6000 Ada Generation, 49140 MiB each
- NVIDIA driver: `580.159.03`
- CUDA reported by `nvidia-smi`: `13.0`

## Final Service Layout

| Port | Service | GPU | Status | Purpose |
| --- | --- | --- | --- | --- |
| `8000` | `ai-llm` | GPU0 + GPU1 | enabled, active | Qwen3.6 FP8 LLM + multimodal endpoint |
| `8001` | `ai-vlm` | none | disabled, inactive | Old Qwen2.5-VL endpoint intentionally stopped |
| `8002` | `ai-speech` | GPU2 environment | enabled, active | SenseVoiceSmall speech recognition |
| `8188` | `ai-comfy` | GPU3 | enabled, active | Primary ComfyUI instance |
| `8189` | `ai-comfy-gpu2` | GPU2 | enabled, active | Secondary ComfyUI instance |
| `9999` | `ai-chat-web` | none | enabled, active | Browser chat UI and server-side Qwen3.6 proxy |

## Qwen3.6 Runtime Configuration

File:

```text
/home/ubuntu/ai-stack/bin/run-llm.sh
```

Current important flags:

```bash
export CUDA_VISIBLE_DEVICES=0,1

vllm serve Qwen/Qwen3.6-35B-A3B-FP8 \
  --served-model-name qwen3.6-35b-a3b \
  --host 192.168.100.12 \
  --port 8000 \
  --tensor-parallel-size 2 \
  --max-model-len 131072 \
  --max-num-seqs 4 \
  --max-num-batched-tokens 8192 \
  --gpu-memory-utilization 0.86 \
  --enforce-eager \
  --disable-custom-all-reduce \
  --reasoning-parser qwen3
```

Important details:

- `--language-model-only` is not present, so Qwen3.6 multimodal input is enabled.
- `--enforce-eager` is present because the CUDA graph path repeatedly stalled during TP=2 multimodal startup.
- `--disable-custom-all-reduce` is present because the TP=2 service stabilized after falling back to NCCL-style communication.
- `VLLM_USE_FLASHINFER_SAMPLER=0` is set because the server does not have `/usr/local/cuda/nvcc`; FlashInfer sampler JIT failed without it.
- The service reads its API key from the local script. Do not copy that key into docs or scripts.

## Model Inventory

Current active model endpoints:

| Endpoint | Served model name | Root model |
| --- | --- | --- |
| `8000` | `qwen3.6-35b-a3b` | `Qwen/Qwen3.6-35B-A3B-FP8` |
| `8002` | `iic/SenseVoiceSmall` | `iic/SenseVoiceSmall` |

Public FRP endpoint:

| Public endpoint | Windows-side target | Purpose |
| --- | --- | --- |
| `60.205.213.254:9000` | `192.168.100.12:8000` | Qwen3.6 OpenAI-compatible API and `/health` |
| `60.205.213.254:9999` | `192.168.100.12:9999` | AI Chat Web UI and `/health` |

Current ComfyUI model files observed:

| Model file | Approx size | Path under ComfyUI models |
| --- | ---: | --- |
| `sd_xl_base_1.0.safetensors` | 6.46 GiB | `checkpoints/` |
| `Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors` | 6.62 GiB | `checkpoints/` |
| `wan2.2_ti2v_5B_fp16.safetensors` | 9.31 GiB | `diffusion_models/` |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | 13.31 GiB | `diffusion_models/` |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | 13.31 GiB | `diffusion_models/` |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | 13.32 GiB | `diffusion_models/` |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | 13.32 GiB | `diffusion_models/` |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` | 1.14 GiB | `loras/` |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` | 1.14 GiB | `loras/` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 1.14 GiB | `loras/` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 1.14 GiB | `loras/` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.27 GiB | `text_encoders/` |
| `wan2.2_vae.safetensors` | 1.31 GiB | `vae/` |
| `wan_2.1_vae.safetensors` | 242 MiB | `vae/` |

`ai-chat-web` currently defaults media generation to:

```bash
AI_CHAT_IMAGE_CHECKPOINT=Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors
AI_CHAT_VIDEO_MODEL_PROFILE=wan22-14b-lightx2v
AI_CHAT_MEDIA_TIMEOUT_SECONDS=1800
```

## Last Verified Health

After enabling the high-quality ComfyUI workflows, the following checks passed:

```text
8000 /health -> 200
8000 /v1/models -> qwen3.6-35b-a3b
8002 /health -> 200
8188 / -> 200
8189 / -> 200
8188 object_info/CheckpointLoaderSimple -> Juggernaut XL v9 listed
8189 object_info/UNETLoader -> Wan2.2 T2V/I2V 14B high/low UNets listed
8189 object_info/LoraLoaderModelOnly -> Wan2.2 Lightx2v T2V/I2V LoRAs listed
8189 object_info/VAELoader -> wan_2.1_vae.safetensors listed
9999 /health -> 200
9999 text-to-image smoke -> completed in 19.56s
9999 text-to-video smoke -> completed in 35.24s
9999 image-to-video smoke -> completed in 4.66s
9999 keyframes-to-video smoke -> completed in 1.69s
8001 /health -> connection refused, expected because ai-vlm is disabled
```

Last observed GPU memory after 128K startup:

| GPU | Used MiB | Free MiB | Assignment |
| --- | ---: | ---: | --- |
| GPU0 | 41566 | 6944 | Qwen3.6 TP worker |
| GPU1 | 41564 | 6946 | Qwen3.6 TP worker |
| GPU2 | 436 | 48074 | Secondary ComfyUI, speech environment |
| GPU3 | 436 | 48074 | Primary ComfyUI |

## Backup Points

Important remote backups created during the change:

```text
/home/ubuntu/ai-stack/backups/rebalance-20260623-225506
/home/ubuntu/ai-stack/bin/run-llm.sh.bak-128k-20260624-081037
```

Use these only as recovery references. Prefer the rollback helper in `scripts/ai-stack/rollback-ai-stack-backup.sh` if restoring a full backup directory.
