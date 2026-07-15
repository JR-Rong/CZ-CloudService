# AI Stack Runbook

This runbook describes how to operate the current AI server deployment.

## Login

Interactive login path:

```bash
ssh -p 2222 admin@60.205.213.254
ssh ubuntu@192.168.100.12
```

Do not store passwords in shell history, scripts, docs, or Git.

You can also try the helper from this repository:

```bash
scripts/ai-stack/open-ai-server-session.sh
```

The helper still prompts interactively for passwords.

## Status Check

After logging into `192.168.100.12`, run:

```bash
bash scripts/ai-stack/collect-ai-stack-status.sh
```

If the script is still only on your local machine, copy it through the SSH path first. The AI host is an internal address, so direct `scp ubuntu@192.168.100.12:...` only works from a machine that can route to that subnet. From a local machine that reaches the server through the Windows bastion, use `ProxyJump` if TCP forwarding is enabled:

```bash
scp -o ProxyJump=admin@60.205.213.254:2222 \
  scripts/ai-stack/collect-ai-stack-status.sh \
  ubuntu@192.168.100.12:/tmp/
```

If the bastion does not allow `ProxyJump`, open the nested SSH session and paste the script into `/tmp/collect-ai-stack-status.sh` with a heredoc:

```bash
cat > /tmp/collect-ai-stack-status.sh <<'SCRIPT'
# paste script content here
SCRIPT
chmod +x /tmp/collect-ai-stack-status.sh
bash /tmp/collect-ai-stack-status.sh
```

Expected services:

```text
ai-llm active enabled
ai-vlm inactive disabled
ai-speech active enabled
ai-comfy active enabled
ai-comfy-gpu2 active enabled
```

## Smoke Test

Run on the AI server:

```bash
bash scripts/ai-stack/smoke-qwen36.sh
```

The script reads the API key from `/home/ubuntu/ai-stack/bin/run-llm.sh`; it does not print the key.

Expected:

```text
models_http=200
text_http=200
image_http=200
```

The script fails if the text answer does not contain `2`, or if the image
answer does not contain `白` or `white` for the built-in one-pixel sample image.

## Change Qwen3.6 Context Length

Run on the AI server:

```bash
sudo bash scripts/ai-stack/set-qwen36-context.sh 131072 --restart
```

Supported common values:

- `32768`
- `65536`
- `131072`

The current stable value is `131072`.

The script creates a timestamped backup beside `run-llm.sh` before editing.

## Reapply Current GPU Layout

Run only when you intentionally want to reapply the current layout:

```bash
sudo bash scripts/ai-stack/rebalance-qwen36-comfy.sh --apply
```

Default layout:

```text
GPU0+1 -> Qwen3.6 FP8 TP=2, port 8000
GPU2   -> secondary ComfyUI, port 8189; speech environment remains on GPU2
GPU3   -> primary ComfyUI, port 8188
8001   -> old ai-vlm disabled
```

The script is dry-run by default. It changes services only with `--apply`.

## Roll Back From a Backup Directory

Use only if a change breaks the service and you want to restore a known backup directory:

```bash
sudo bash scripts/ai-stack/rollback-ai-stack-backup.sh /home/ubuntu/ai-stack/backups/rebalance-20260623-225506 --apply
```

This restores files that exist in the backup directory and restarts only AI
services that are currently enabled. Use `--restart-disabled` only when you
intentionally want to start a disabled service such as `ai-vlm.service`.

## Ports

| Port | Expected result |
| --- | --- |
| `8000 /health` | `200` |
| `8001 /health` | connection refused, expected |
| `8002 /health` | `200` |
| `8188 /` | `200` |
| `8189 /` | `200` |
| `9999 /health` | `200` |

Public FRP exposure:

| Public endpoint | Windows-side target | Expected result |
| --- | --- | --- |
| `http://60.205.213.254:9000/health` | `192.168.100.12:8000/health` | HTTP `200` after Windows `frpc` registers `ai-llm-qwen36-9000` |
| `http://60.205.213.254:9000/v1/models` | `192.168.100.12:8000/v1/models` | Requires the runtime API key |
| `http://60.205.213.254:9999/health` | `192.168.100.12:9999/health` | HTTP `200` after Windows `frpc` registers `ai-chat-web-9999` |
| `http://60.205.213.254:9999/` | `192.168.100.12:9999/` | Browser AI Chat Web UI |

## Troubleshooting Notes

- If Qwen3.6 fails with FlashInfer or `nvcc` errors, confirm `VLLM_USE_FLASHINFER_SAMPLER=0` is set.
- If TP=2 stalls after KV cache allocation, confirm `--disable-custom-all-reduce` is present.
- If startup is slow, check `journalctl -u ai-llm.service -f`.
- If ComfyUI uses little GPU memory at idle, that is normal; model weights are loaded when a workflow runs.
- If `8001` is down, that is expected in the current architecture.
- If ECS local `curl --noproxy '*' -i http://127.0.0.1:9000/health` returns
  HTTP `200` but external `curl http://60.205.213.254:9000/health` fails, run
  `tcpdump -nni any tcp port 9000` on ECS during the external request. No
  captured packets means the cloud security group or EIP ingress for `9000/tcp`
  is still blocking before the request reaches `frps`.
