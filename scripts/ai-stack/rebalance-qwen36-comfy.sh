#!/usr/bin/env bash
set -euo pipefail

APPLY="no"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-131072}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.86}"

usage() {
  cat <<'EOF'
Usage:
  rebalance-qwen36-comfy.sh [--apply]

Reapplies the current AI server layout:
  GPU0+1 -> Qwen3.6 FP8 TP=2 multimodal endpoint on 8000
  GPU2   -> secondary ComfyUI on 8189; speech environment remains on GPU2
  GPU3   -> primary ComfyUI on 8188
  8001   -> old ai-vlm stopped and disabled

Environment overrides:
  MAX_MODEL_LEN=131072
  GPU_MEMORY_UTILIZATION=0.86

The script is dry-run unless --apply is provided.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY="yes" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

run() {
  echo "+ $*"
  if [ "$APPLY" = "yes" ]; then
    "$@"
  fi
}

write_file() {
  local path="$1"
  local mode="$2"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ "$APPLY" = "yes" ]; then
    if [[ "$path" == /etc/* ]]; then
      sudo install -m "$mode" "$tmp" "$path"
    else
      install -m "$mode" "$tmp" "$path"
    fi
  else
    echo "--- would write $path"
    sed -E 's/(--api-key +)[^ ]+/\1<redacted>/' "$tmp"
  fi
  rm -f "$tmp"
}

RUN_LLM="/home/ubuntu/ai-stack/bin/run-llm.sh"
RUN_COMFY_GPU2="/home/ubuntu/ai-stack/bin/run-comfy-gpu2.sh"
BACKUP_ROOT="/home/ubuntu/ai-stack/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/rebalance-${STAMP}"

if [ ! -f "$RUN_LLM" ]; then
  echo "Missing $RUN_LLM" >&2
  exit 2
fi

API_KEY="$(grep -oE -- '--api-key +[^ ]+' "$RUN_LLM" | awk '{print $2}' | tail -1 || true)"
if [ -z "$API_KEY" ]; then
  echo "Could not read API key from $RUN_LLM" >&2
  exit 2
fi

echo "Mode: $([ "$APPLY" = yes ] && echo apply || echo dry-run)"
echo "Backup dir: $BACKUP_DIR"

if [ "$APPLY" = "yes" ]; then
  mkdir -p "$BACKUP_DIR"
  for file in \
    /home/ubuntu/ai-stack/bin/run-llm.sh \
    /home/ubuntu/ai-stack/bin/run-vlm.sh \
    /home/ubuntu/ai-stack/bin/run-speech.sh \
    /home/ubuntu/ai-stack/bin/run-comfy.sh \
    /home/ubuntu/ai-stack/bin/run-comfy-gpu2.sh \
    /etc/systemd/system/ai-llm.service \
    /etc/systemd/system/ai-vlm.service \
    /etc/systemd/system/ai-speech.service \
    /etc/systemd/system/ai-comfy.service \
    /etc/systemd/system/ai-comfy-gpu2.service; do
    [ -e "$file" ] && sudo cp -a "$file" "$BACKUP_DIR/$(basename "$file")"
  done
fi

write_file "$RUN_LLM" 0755 <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/ai-stack
export VLLM_USE_MODELSCOPE=True
export HF_HOME=/home/ubuntu/ai-stack/cache/hf
export MODELSCOPE_CACHE=/home/ubuntu/ai-stack/cache/modelscope
export CUDA_VISIBLE_DEVICES=0,1
export VLLM_WORKER_MULTIPROC_METHOD=spawn
export VLLM_USE_FLASHINFER_SAMPLER=0
exec /home/ubuntu/ai-stack/venv/bin/vllm serve Qwen/Qwen3.6-35B-A3B-FP8 \\
  --served-model-name qwen3.6-35b-a3b \\
  --host 192.168.100.12 \\
  --port 8000 \\
  --tensor-parallel-size 2 \\
  --max-model-len ${MAX_MODEL_LEN} \\
  --max-num-seqs 4 \\
  --max-num-batched-tokens 8192 \\
  --gpu-memory-utilization ${GPU_MEMORY_UTILIZATION} \\
  --enforce-eager \\
  --disable-custom-all-reduce \\
  --reasoning-parser qwen3 \\
  --api-key ${API_KEY}
EOF

write_file "$RUN_COMFY_GPU2" 0755 <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export CUDA_VISIBLE_DEVICES=2
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
cd /home/ubuntu/ai-stack/comfyui
exec ./venv/bin/python main.py --listen 192.168.100.12 --port 8189
EOF

write_file "/etc/systemd/system/ai-comfy-gpu2.service" 0644 <<'EOF'
[Unit]
Description=AI Stack ComfyUI secondary GPU2 image video
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ai-stack
Environment=HOME=/home/ubuntu
ExecStart=/home/ubuntu/ai-stack/bin/run-comfy-gpu2.sh
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF

if [ "$APPLY" = "yes" ]; then
  bash -n "$RUN_LLM"
  bash -n "$RUN_COMFY_GPU2"
fi

run sudo systemctl daemon-reload
run sudo systemctl stop ai-vlm.service
run sudo systemctl disable ai-vlm.service
run sudo systemctl restart ai-llm.service
run sudo systemctl enable --now ai-comfy-gpu2.service

echo "Done. Run collect-ai-stack-status.sh and smoke-qwen36.sh to verify."
