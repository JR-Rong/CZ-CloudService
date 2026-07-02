#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage: $0

Build and deploy the CZ web disk webpage and File Browser service to Windows.

Common environment overrides:
  CZ_DRIVE_HOST=60.205.213.254
  CZ_DRIVE_SSH_PORT=2222
  CZ_DRIVE_SSH_USER=admin
  CZ_SSH_PASSWORD=123456
  CZ_WINDOWS_ADMIN_PASSWORD=123456
  CZ_FILEBROWSER_WEB_PASSWORD=123456
  CZ_DRIVE_PORT=2233
  CZ_FRONTEND_BUILD_MODE=auto

This entrypoint delegates the build, upload, Windows install, frpc setup, and
public endpoint verification to deploy-filebrowser-drive-remote.sh.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

exec "$script_dir/deploy-filebrowser-drive-remote.sh" "$@"
