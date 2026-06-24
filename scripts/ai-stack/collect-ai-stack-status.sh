#!/usr/bin/env bash
set -euo pipefail

HOST="${AI_BIND_HOST:-192.168.100.12}"
VENV_PYTHON="${AI_STACK_PYTHON:-/home/ubuntu/ai-stack/venv/bin/python}"
BIN_DIR="${AI_STACK_BIN_DIR:-/home/ubuntu/ai-stack/bin}"
COMFY_MODELS="${COMFY_MODELS_DIR:-/home/ubuntu/ai-stack/comfyui/models}"

redact() {
  sed -E \
    -e 's/(--api-key +)[^ ]+/\1<redacted>/g' \
    -e 's/(AI_API_KEY=).*/\1<redacted>/g' \
    -e 's/sk-local-[A-Za-z0-9]+/<redacted-key>/g'
}

section() {
  printf '\n## %s\n' "$1"
}

curl_code() {
  local url="$1"
  curl -sS --connect-timeout 2 --max-time 5 -o /tmp/ai-stack-status.out -w '%{http_code}' "$url" 2>/dev/null || true
}

section "Time / Host"
date '+%F %T %Z'
hostname
uname -r

section "GPU Summary"
nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw \
  --format=csv,noheader,nounits || true

section "GPU Processes"
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true

section "Systemd Services"
for svc in ai-llm ai-vlm ai-speech ai-comfy ai-comfy-gpu2; do
  printf '%s active=%s enabled=%s mainpid=%s\n' \
    "$svc" \
    "$(systemctl is-active "$svc.service" 2>/dev/null || true)" \
    "$(systemctl is-enabled "$svc.service" 2>/dev/null || true)" \
    "$(systemctl show "$svc.service" -p MainPID --value 2>/dev/null || true)"
done

section "Ports"
for url in \
  "http://${HOST}:8000/health" \
  "http://${HOST}:8001/health" \
  "http://${HOST}:8002/health" \
  "http://${HOST}:8188/" \
  "http://${HOST}:8189/"; do
  printf '%s -> %s\n' "$url" "$(curl_code "$url")"
done

section "OpenAI Model Endpoints"
for name_port in llm:8000 vlm:8001; do
  name="${name_port%%:*}"
  port="${name_port##*:}"
  script="${BIN_DIR}/run-${name}.sh"
  printf 'port=%s ' "$port"
  if [ ! -f "$script" ]; then
    echo "script_missing=$script"
    continue
  fi
  key="$(grep -oE -- '--api-key +[^ ]+' "$script" 2>/dev/null | awk '{print $2}' | tail -1 || true)"
  if [ -z "$key" ]; then
    echo "api_key_missing"
    continue
  fi
  tmp="/tmp/ai-stack-models-${port}.json"
  code="$(curl -sS --connect-timeout 2 --max-time 5 -o "$tmp" -w '%{http_code}' \
    "http://${HOST}:${port}/v1/models" -H "Authorization: Bearer ${key}" 2>/dev/null || true)"
  printf 'http=%s ' "$code"
  if [ "$code" = "200" ] && [ -x "$VENV_PYTHON" ]; then
    "$VENV_PYTHON" - "$tmp" <<'PY' || true
import json
import sys
path = sys.argv[1]
data = json.load(open(path))
print("models=" + ",".join(item.get("id", "") for item in data.get("data", [])))
PY
  else
    echo
  fi
done

section "Run Script Flags"
for script in "${BIN_DIR}/run-llm.sh" "${BIN_DIR}/run-vlm.sh" "${BIN_DIR}/run-speech.sh" "${BIN_DIR}/run-comfy.sh" "${BIN_DIR}/run-comfy-gpu2.sh"; do
  echo "--- ${script}"
  if [ -f "$script" ]; then
    grep -E 'CUDA_VISIBLE_DEVICES|served-model-name|vllm serve|ASR_MODEL|ASR_DEVICE|--port|tensor-parallel|max-model-len|max-num-seqs|gpu-memory|language-model-only|enforce|disable-custom|reasoning-parser' "$script" | redact || true
  else
    echo "missing"
  fi
done

section "ComfyUI Model Files"
if [ -d "$COMFY_MODELS" ]; then
  find "$COMFY_MODELS" -maxdepth 2 -type f \( -name '*.safetensors' -o -name '*.ckpt' -o -name '*.pt' -o -name '*.pth' \) -printf '%p %s\n' 2>/dev/null |
    sed "s#${COMFY_MODELS}/##" |
    awk '{size=$NF; $NF=""; printf "%.2fGiB %s\n", size/1024/1024/1024, $0}' |
    sort -h
else
  echo "missing: ${COMFY_MODELS}"
fi
