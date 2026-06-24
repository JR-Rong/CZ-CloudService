#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  set-qwen36-context.sh <max_model_len> [--restart|--no-restart]

Examples:
  sudo bash set-qwen36-context.sh 131072 --restart
  sudo bash set-qwen36-context.sh 32768 --no-restart
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  usage
  exit 0
fi

CONTEXT="$1"
RESTART="no"
shift || true

case "$CONTEXT" in
  ''|*[!0-9]*)
    echo "max_model_len must be a positive integer." >&2
    exit 2
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart) RESTART="yes" ;;
    --no-restart) RESTART="no" ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

SCRIPT="${RUN_LLM:-/home/ubuntu/ai-stack/bin/run-llm.sh}"
HOST="${AI_BIND_HOST:-192.168.100.12}"

if [ ! -f "$SCRIPT" ]; then
  echo "Missing $SCRIPT" >&2
  exit 2
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup="${SCRIPT}.bak-context-${CONTEXT}-${stamp}"
cp -a "$SCRIPT" "$backup"

tmp="$(mktemp)"
sed -E "s/--max-model-len +[0-9]+/--max-model-len ${CONTEXT}/" "$SCRIPT" > "$tmp"
cat "$tmp" > "$SCRIPT"
rm -f "$tmp"
chmod +x "$SCRIPT"
bash -n "$SCRIPT"

echo "Updated $SCRIPT"
echo "Backup: $backup"
grep -E 'CUDA_VISIBLE_DEVICES|tensor-parallel|max-model-len|max-num-seqs|gpu-memory|enforce|disable-custom|reasoning-parser' "$SCRIPT"

if [ "$RESTART" != "yes" ]; then
  echo "Not restarting. Rerun with --restart to restart ai-llm.service."
  exit 0
fi

sudo systemctl restart ai-llm.service

for i in $(seq 1 30); do
  printf 'check=%s ' "$i"
  active="$(systemctl is-active ai-llm.service 2>/dev/null || true)"
  code="$(curl -sS --connect-timeout 2 --max-time 5 -o /tmp/qwen-context-health.out -w '%{http_code}' "http://${HOST}:8000/health" 2>/dev/null || true)"
  gpu="$(nvidia-smi --query-gpu=index,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | tr '\n' ';' || true)"
  echo "active=${active} health=${code} gpu=${gpu}"
  [ "$code" = "200" ] && exit 0
  sleep 30
done

echo "ai-llm did not become healthy within the wait window." >&2
echo "Recent logs:" >&2
journalctl -u ai-llm.service -n 120 -o cat --no-pager >&2 || true
exit 1
