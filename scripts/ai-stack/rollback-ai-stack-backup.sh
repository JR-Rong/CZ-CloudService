#!/usr/bin/env bash
set -euo pipefail

APPLY="no"
RESTART_DISABLED="no"

usage() {
  cat <<'EOF'
Usage:
  rollback-ai-stack-backup.sh <backup_dir> [--apply] [--restart-disabled]

Restores AI stack files from a backup directory created under:
  /home/ubuntu/ai-stack/backups/

The script is dry-run unless --apply is provided. In apply mode, it restarts
only currently enabled services by default. Use --restart-disabled only when
you intentionally want to start services that are disabled in the current
architecture.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  usage
  exit 0
fi

BACKUP_DIR="$1"
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY="yes" ;;
    --restart-disabled) RESTART_DISABLED="yes" ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ ! -d "$BACKUP_DIR" ]; then
  echo "Backup directory not found: $BACKUP_DIR" >&2
  exit 2
fi

restore_file() {
  local name="$1"
  local dest="$2"
  local mode="$3"
  local src="${BACKUP_DIR}/${name}"

  if [ ! -e "$src" ]; then
    echo "skip missing $src"
    return
  fi

  echo "restore $src -> $dest"
  if [ "$APPLY" = "yes" ]; then
    if [[ "$dest" == /etc/* ]]; then
      sudo install -m "$mode" "$src" "$dest"
    else
      install -m "$mode" "$src" "$dest"
    fi
  fi
}

echo "Mode: $([ "$APPLY" = yes ] && echo apply || echo dry-run)"

restore_file run-llm.sh /home/ubuntu/ai-stack/bin/run-llm.sh 0755
restore_file run-vlm.sh /home/ubuntu/ai-stack/bin/run-vlm.sh 0755
restore_file run-speech.sh /home/ubuntu/ai-stack/bin/run-speech.sh 0755
restore_file run-comfy.sh /home/ubuntu/ai-stack/bin/run-comfy.sh 0755
restore_file run-comfy-gpu2.sh /home/ubuntu/ai-stack/bin/run-comfy-gpu2.sh 0755

restore_file ai-llm.service /etc/systemd/system/ai-llm.service 0644
restore_file ai-vlm.service /etc/systemd/system/ai-vlm.service 0644
restore_file ai-speech.service /etc/systemd/system/ai-speech.service 0644
restore_file ai-comfy.service /etc/systemd/system/ai-comfy.service 0644
restore_file ai-comfy-gpu2.service /etc/systemd/system/ai-comfy-gpu2.service 0644

if [ "$APPLY" = "yes" ]; then
  sudo systemctl daemon-reload
  for svc in ai-llm ai-vlm ai-speech ai-comfy ai-comfy-gpu2; do
    unit="${svc}.service"
    if ! systemctl cat "$unit" >/dev/null 2>&1; then
      echo "skip missing $unit"
      continue
    fi

    enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    case "$enabled_state" in
      enabled|enabled-runtime)
        echo "restart enabled $unit"
        sudo systemctl restart "$unit" || true
        ;;
      *)
        if [ "$RESTART_DISABLED" = "yes" ]; then
          echo "restart $unit despite enabled_state=${enabled_state:-unknown}"
          sudo systemctl restart "$unit" || true
        else
          echo "skip $unit enabled_state=${enabled_state:-unknown}; use --restart-disabled to start it"
        fi
        ;;
    esac
  done
else
  for svc in ai-llm ai-vlm ai-speech ai-comfy ai-comfy-gpu2; do
    if [ "$RESTART_DISABLED" = "yes" ]; then
      echo "dry-run restart policy: would restart ${svc}.service even if disabled"
    else
      echo "dry-run restart policy: would restart ${svc}.service only if currently enabled"
    fi
  done
fi

echo "Rollback file restore complete."
