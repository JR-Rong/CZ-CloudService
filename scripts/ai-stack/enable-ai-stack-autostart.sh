#!/usr/bin/env bash
set -euo pipefail

APPLY="no"
START="no"

ENABLE_SERVICES=(
  ai-llm
  ai-speech
  ai-comfy
  ai-comfy-gpu2
  ai-chat-web
)

DISABLE_SERVICES=(
  ai-vlm
)

usage() {
  cat <<'EOF'
Usage:
  enable-ai-stack-autostart.sh [--apply] [--start]

Enables boot autostart for the current AI stack services on the Ubuntu AI
server. The old ai-vlm.service remains intentionally disabled.

Default mode is dry-run. Use --apply on the AI server to change systemd state.
Use --start with --apply when the services should also be started immediately.

Expected AI server:
  192.168.100.12, user ubuntu

Autostart targets:
  enable:  ai-llm ai-speech ai-comfy ai-comfy-gpu2 ai-chat-web
  disable: ai-vlm
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY="yes" ;;
    --start) START="yes" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ "$START" = "yes" ] && [ "$APPLY" != "yes" ]; then
  echo "--start requires --apply" >&2
  exit 2
fi

run() {
  echo "+ $*"
  if [ "$APPLY" = "yes" ]; then
    "$@"
  fi
}

service_exists() {
  systemctl cat "$1.service" >/dev/null 2>&1
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; run this on the Ubuntu AI server." >&2
    exit 2
  fi
}

print_state() {
  local svc
  for svc in "${ENABLE_SERVICES[@]}" "${DISABLE_SERVICES[@]}"; do
    if service_exists "$svc"; then
      printf '%s active=%s enabled=%s\n' \
        "$svc" \
        "$(systemctl is-active "$svc.service" 2>/dev/null || true)" \
        "$(systemctl is-enabled "$svc.service" 2>/dev/null || true)"
    else
      printf '%s missing\n' "$svc"
    fi
  done
}

require_systemd

echo "Mode: $([ "$APPLY" = yes ] && echo apply || echo dry-run)"
echo
echo "Before:"
print_state
echo

run sudo systemctl daemon-reload

for svc in "${ENABLE_SERVICES[@]}"; do
  if service_exists "$svc"; then
    run sudo systemctl enable "$svc.service"
  else
    echo "skip missing: $svc.service" >&2
  fi
done

for svc in "${DISABLE_SERVICES[@]}"; do
  if service_exists "$svc"; then
    run sudo systemctl disable "$svc.service"
  else
    echo "skip missing: $svc.service" >&2
  fi
done

if [ "$START" = "yes" ]; then
  for svc in "${ENABLE_SERVICES[@]}"; do
    if service_exists "$svc"; then
      run sudo systemctl start "$svc.service"
    fi
  done
  for svc in "${DISABLE_SERVICES[@]}"; do
    if service_exists "$svc"; then
      run sudo systemctl stop "$svc.service"
    fi
  done
fi

echo
echo "After:"
print_state
