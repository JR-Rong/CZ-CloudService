#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

drive_host="${CZ_DRIVE_HOST:-60.205.213.254}"
remote_host="${CZ_DRIVE_SSH_HOST:-$drive_host}"
public_host="${CZ_DRIVE_PUBLIC_HOST:-$drive_host}"
remote_ssh_port="${CZ_DRIVE_SSH_PORT:-2222}"
remote_user="${CZ_DRIVE_SSH_USER:-admin}"
remote_install_dir="${CZ_DRIVE_INSTALL_DIR:-C:/CZCloudDrive}"
drive_port="${CZ_DRIVE_PORT:-2233}"
filebrowser_version="${CZ_FILEBROWSER_VERSION:-v2.63.15}"
windows_admin_password="${CZ_WINDOWS_ADMIN_PASSWORD:-123456}"
web_password="${CZ_FILEBROWSER_WEB_PASSWORD:-123456}"
setup_frpc="${CZ_SETUP_FRPC:-1}"
frontend_build_mode="${CZ_FRONTEND_BUILD_MODE:-auto}"
go_build_mode="${CZ_GO_BUILD_MODE:-docker}"
node_image="${CZ_NODE_IMAGE:-node:22-bookworm}"
go_image="${CZ_GO_IMAGE:-golang:1.25}"
build_root="${CZ_FILEBROWSER_BUILD_DIR:-$repo_root/.work/filebrowser-build}"
source_dir="$build_root/source"
patch_file="$repo_root/patches/filebrowser/cz-spaces-v2.63.15.patch"
binary_path="$source_dir/filebrowser-cz.exe"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage: $0

Environment overrides:
  CZ_DRIVE_HOST=60.205.213.254       # default for SSH and public verification
  CZ_DRIVE_SSH_HOST=60.205.213.254   # override SSH target only
  CZ_DRIVE_PUBLIC_HOST=60.205.213.254 # override public verification host only
  CZ_DRIVE_SSH_PORT=2222
  CZ_DRIVE_SSH_USER=admin
  CZ_SSH_PASSWORD=123456              # optional; requires sshpass
  CZ_WINDOWS_ADMIN_PASSWORD=123456    # password used by Windows scheduled tasks
  CZ_FILEBROWSER_WEB_PASSWORD=123456  # File Browser admin password
  CZ_DRIVE_PORT=2233
  CZ_SETUP_FRPC=1                     # set 0 to skip cloud-drive frpc setup
  CZ_FRONTEND_BUILD_MODE=auto          # auto, local, or docker
  CZ_NODE_IMAGE=node:22-bookworm       # override when Docker Hub is slow/blocked
  CZ_GO_BUILD_MODE=docker              # docker or local
  CZ_GO_IMAGE=golang:1.25              # override when Docker Hub is slow/blocked
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

for cmd in git ssh scp curl python3; do
  require_cmd "$cmd"
done

if [[ ! -f "$patch_file" ]]; then
  echo "Missing File Browser patch: $patch_file" >&2
  exit 1
fi

ssh_cmd=(ssh -o StrictHostKeyChecking=accept-new -p "$remote_ssh_port")
scp_cmd=(scp -P "$remote_ssh_port")
if [[ -n "${CZ_SSH_PASSWORD:-}" ]]; then
  require_cmd sshpass
  ssh_cmd=(sshpass -p "$CZ_SSH_PASSWORD" "${ssh_cmd[@]}")
  scp_cmd=(sshpass -p "$CZ_SSH_PASSWORD" "${scp_cmd[@]}")
fi

remote_target="$remote_user@$remote_host"
public_base_url="http://$public_host:$drive_port"

remote_powershell() {
  "${ssh_cmd[@]}" "$remote_target" \
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$script = [Console]::In.ReadToEnd(); Invoke-Expression $script"'
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

build_frontend() {
  case "$frontend_build_mode" in
    auto)
      if can_build_frontend_local; then
        build_frontend_local
      else
        build_frontend_docker
      fi
      ;;
    local)
      build_frontend_local
      ;;
    docker)
      build_frontend_docker
      ;;
    *)
      echo "Invalid CZ_FRONTEND_BUILD_MODE: $frontend_build_mode" >&2
      exit 1
      ;;
  esac
}

can_build_frontend_local() {
  command -v pnpm >/dev/null 2>&1 || {
    command -v node >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1
  }
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    corepack pnpm "$@"
  fi
}

build_frontend_local() {
  if ! can_build_frontend_local; then
    echo "Missing pnpm, or node + corepack, for local frontend build." >&2
    exit 1
  fi
  (
    cd "$source_dir/frontend"
    run_pnpm install --frozen-lockfile
    run_pnpm run build
  )
}

docker_failure_hint() {
  local image="$1"
  cat >&2 <<EOF

Docker image failed: $image

If this host cannot reach Docker Hub, use one of these options:
  - Set CZ_NODE_IMAGE or CZ_GO_IMAGE to an image registry this host can pull.
  - Pre-pull the image on this host and rerun the script.
  - Install local Node.js/corepack/pnpm and use CZ_FRONTEND_BUILD_MODE=local.
  - Install local Go and use CZ_GO_BUILD_MODE=local.

When running on the cloud frps host itself, also consider:
  CZ_DRIVE_SSH_HOST=127.0.0.1
  CZ_DRIVE_PUBLIC_HOST=60.205.213.254
EOF
}

build_frontend_docker() {
  require_cmd docker
  if ! docker run --rm \
    -v "$source_dir:/src" \
    -w /src/frontend \
    "$node_image" \
    bash -lc 'corepack enable && pnpm install --frozen-lockfile && pnpm run build'; then
    docker_failure_hint "$node_image"
    exit 1
  fi
}

build_windows_binary() {
  case "$go_build_mode" in
    docker)
      build_windows_binary_docker
      ;;
    local)
      build_windows_binary_local
      ;;
    *)
      echo "Invalid CZ_GO_BUILD_MODE: $go_build_mode" >&2
      exit 1
      ;;
  esac
}

build_windows_binary_local() {
  require_cmd go
  (
    cd "$source_dir"
    GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$binary_path"
  )
}

build_windows_binary_docker() {
  require_cmd docker
  if ! docker run --rm \
    -v "$source_dir:/src" \
    -w /src \
    -e GOOS=windows \
    -e GOARCH=amd64 \
    "$go_image" \
    go build -trimpath -ldflags='-s -w' -o /src/filebrowser-cz.exe; then
    docker_failure_hint "$go_image"
    exit 1
  fi
}

echo "==> Building custom File Browser $filebrowser_version"
rm -rf "$source_dir"
mkdir -p "$build_root"
git clone --depth 1 --branch "$filebrowser_version" https://github.com/filebrowser/filebrowser.git "$source_dir"
git -C "$source_dir" apply "$patch_file"

build_frontend

build_windows_binary

if [[ ! -s "$binary_path" ]]; then
  echo "Build did not produce $binary_path" >&2
  exit 1
fi

echo "==> Uploading deployment assets to $remote_target:$remote_install_dir"
"${ssh_cmd[@]}" "$remote_target" \
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"New-Item -ItemType Directory -Force -Path '$remote_install_dir' | Out-Null\""
"${scp_cmd[@]}" "$binary_path" "$remote_target:$remote_install_dir/filebrowser-cz.exe"
"${scp_cmd[@]}" "$repo_root/scripts/windows/install-filebrowser-drive.ps1" "$remote_target:$remote_install_dir/install-filebrowser-drive.ps1"
"${scp_cmd[@]}" "$repo_root/scripts/windows/setup-cloud-drive-frpc.ps1" "$remote_target:$remote_install_dir/setup-cloud-drive-frpc.ps1"

remote_install_dir_ps="${remote_install_dir//\//\\}"
admin_pw_json="$(json_escape "$windows_admin_password")"
web_pw_json="$(json_escape "$web_password")"
port_json="$(json_escape "$drive_port")"
install_dir_json="$(json_escape "$remote_install_dir_ps")"
setup_frpc_json="$(json_escape "$setup_frpc")"

echo "==> Installing and restarting Windows service"
remote_powershell <<PWSH
\$ErrorActionPreference = "Stop"
\$InstallDir = $install_dir_json
\$Port = $port_json
\$AdminPassword = $admin_pw_json
\$WebPassword = $web_pw_json
\$SetupFrpc = $setup_frpc_json
\$TaskName = "CZCloudDrive"
\$ExePath = Join-Path \$InstallDir "filebrowser.exe"
\$NewExePath = Join-Path \$InstallDir "filebrowser-cz.exe"
\$BackupPath = Join-Path \$InstallDir ("filebrowser-backup-" + (Get-Date -Format "yyyyMMddHHmmss") + ".exe")

\$task = Get-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue
if (\$task) {
  Stop-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

\$listeners = Get-NetTCPConnection -LocalPort \$Port -State Listen -ErrorAction SilentlyContinue
foreach (\$listener in \$listeners) {
  if (\$listener.OwningProcess -and \$listener.OwningProcess -ne 0) {
    Stop-Process -Id \$listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

if (!(Test-Path \$NewExePath)) {
  throw "New File Browser binary is missing: \$NewExePath"
}
if (Test-Path \$ExePath) {
  Copy-Item \$ExePath \$BackupPath -Force
}
Move-Item \$NewExePath \$ExePath -Force

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$InstallDir "install-filebrowser-drive.ps1") -AdminPassword \$AdminPassword -WebPassword \$WebPassword -Port \$Port

if (\$SetupFrpc -ne "0") {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$InstallDir "setup-cloud-drive-frpc.ps1") -AdminPassword \$AdminPassword -Port \$Port
}
PWSH

echo "==> Verifying public web endpoint"
html="$(curl -fsS --max-time 20 "$public_base_url/")"
asset="$(printf '%s' "$html" | grep -Eo 'assets/index-[^"]+\.js' | head -n 1 || true)"
if [[ -z "$asset" ]]; then
  echo "Could not find frontend index asset in $public_base_url/" >&2
  exit 1
fi
curl -fsS --max-time 20 "$public_base_url/static/$asset" |
  LC_ALL=C grep -aE 'toPrivateSpace|toSharedSpace' >/dev/null

token="$(
  curl -fsS --max-time 20 \
    -X POST "$public_base_url/api/login" \
    -H 'Content-Type: application/json' \
    --data "{\"username\":\"admin\",\"password\":\"$web_password\"}"
)"

for encoded_path in '%E7%A7%81%E4%BA%BA%E7%A9%BA%E9%97%B4' '%E5%85%B1%E4%BA%AB%E7%A9%BA%E9%97%B4'; do
  curl -fsS --max-time 20 \
    -H "X-Auth: $token" \
    "$public_base_url/api/resources/$encoded_path" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["isDir"] is True'
done

echo "Deployment completed: $public_base_url"
