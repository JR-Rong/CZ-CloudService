#!/usr/bin/env bash
set -euo pipefail

APPLY="no"
FRP_VERSION="${FRP_VERSION:-0.69.1}"
BIND_PORT="${FRPS_BIND_PORT:-7000}"
ALLOW_PORTS="${FRPS_ALLOW_PORTS:-2222,2444,9000,9999}"
INSTALL_BIN="${FRPS_BIN:-/usr/local/bin/frps}"
CONFIG_PATH="${FRPS_CONFIG:-/etc/frp/frps.toml}"
SERVICE_PATH="${FRPS_SERVICE:-/etc/systemd/system/frps.service}"
LOG_PATH="${FRPS_LOG:-/var/log/frps.log}"
DOWNLOAD_URL="${FRP_TAR_URL:-}"
TAR_SHA256="${FRP_TAR_SHA256:-}"
TOKEN_FILE=""
AUTH_TOKEN="${FRPS_AUTH_TOKEN:-}"
TMPDIR_TO_CLEAN=""
TMP_FILES_TO_CLEAN=()

cleanup_tmpdir() {
  local tmp_file
  for tmp_file in "${TMP_FILES_TO_CLEAN[@]:-}"; do
    [ -n "$tmp_file" ] && rm -f "$tmp_file"
  done
  if [ -n "$TMPDIR_TO_CLEAN" ] && [ -d "$TMPDIR_TO_CLEAN" ]; then
    rm -rf "$TMPDIR_TO_CLEAN"
  fi
}

trap cleanup_tmpdir EXIT

usage() {
  cat <<'EOF'
Usage:
  setup-frps.sh [--apply] [--token-file PATH] [--bind-port 7000] [--allow-ports 2222,2444,9000,9999[,3000-3010]]

Installs or reuses frps 0.69.1 on Ubuntu/systemd, writes:
  /etc/frp/frps.toml
  /etc/systemd/system/frps.service

The script is dry-run unless --apply is provided. In apply mode, provide the
FRP auth token through FRPS_AUTH_TOKEN, --token-file, or the interactive prompt.

Environment overrides:
  FRP_VERSION=0.69.1
  FRPS_AUTH_TOKEN=<runtime-token>
  FRPS_BIND_PORT=7000
  FRPS_ALLOW_PORTS=2222,2444,9000,9999
  FRPS_BIN=/usr/local/bin/frps
  FRPS_CONFIG=/etc/frp/frps.toml
  FRPS_SERVICE=/etc/systemd/system/frps.service
  FRPS_LOG=/var/log/frps.log
  FRP_TAR_URL=<custom-release-tarball-url>
  FRP_TAR_SHA256=<optional-sha256>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY="yes" ;;
    --token-file)
      TOKEN_FILE="${2:-}"
      [ -n "$TOKEN_FILE" ] || { echo "--token-file requires a path" >&2; exit 2; }
      shift
      ;;
    --bind-port)
      BIND_PORT="${2:-}"
      [ -n "$BIND_PORT" ] || { echo "--bind-port requires a value" >&2; exit 2; }
      shift
      ;;
    --allow-ports)
      ALLOW_PORTS="${2:-}"
      [ -n "$ALLOW_PORTS" ] || { echo "--allow-ports requires a value" >&2; exit 2; }
      shift
      ;;
    --frps-bin)
      INSTALL_BIN="${2:-}"
      [ -n "$INSTALL_BIN" ] || { echo "--frps-bin requires a path" >&2; exit 2; }
      shift
      ;;
    --download-url)
      DOWNLOAD_URL="${2:-}"
      [ -n "$DOWNLOAD_URL" ] || { echo "--download-url requires a URL" >&2; exit 2; }
      shift
      ;;
    --sha256)
      TAR_SHA256="${2:-}"
      [ -n "$TAR_SHA256" ] || { echo "--sha256 requires a hash" >&2; exit 2; }
      shift
      ;;
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

toml_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

validate_port() {
  local value="$1"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "Invalid port: $value" >&2
    exit 2
  fi
}

allow_ports_toml() {
  local raw="$1"
  local part start end first="yes"

  echo "allowPorts = ["
  IFS=',' read -ra parts <<< "$raw"
  for part in "${parts[@]}"; do
    part="${part//[[:space:]]/}"
    if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      start="${BASH_REMATCH[1]}"
      end="${BASH_REMATCH[2]}"
    elif [[ "$part" =~ ^[0-9]+$ ]]; then
      start="$part"
      end="$part"
    else
      echo "Invalid allow port entry: $part" >&2
      exit 2
    fi

    validate_port "$start"
    validate_port "$end"
    if [ "$start" -gt "$end" ]; then
      echo "Invalid allow port range: $part" >&2
      exit 2
    fi

    if [ "$first" = "yes" ]; then
      first="no"
    else
      echo ","
    fi
    printf '  { start = %s, end = %s }' "$start" "$end"
  done
  echo
  echo "]"
}

detect_archive_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo "frp_${FRP_VERSION}_linux_amd64.tar.gz" ;;
    aarch64|arm64) echo "frp_${FRP_VERSION}_linux_arm64.tar.gz" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
  esac
}

write_file() {
  local path="$1"
  local mode="$2"
  local tmp
  tmp="$(mktemp)"
  TMP_FILES_TO_CLEAN+=("$tmp")
  cat > "$tmp"

  if [ "$APPLY" = "yes" ]; then
    run sudo install -d -m 0755 "$(dirname "$path")"
    run sudo install -m "$mode" "$tmp" "$path"
  else
    echo "--- would write $path mode=$mode"
    sed -E 's/(auth\.token = ).*/\1"<redacted-runtime-token>"/' "$tmp"
  fi

  rm -f "$tmp"
}

load_token() {
  if [ -n "$TOKEN_FILE" ]; then
    if [ ! -f "$TOKEN_FILE" ]; then
      echo "Token file not found: $TOKEN_FILE" >&2
      exit 2
    fi
    AUTH_TOKEN="$(head -n 1 "$TOKEN_FILE")"
  fi

  if [ "$APPLY" = "yes" ] && [ -z "$AUTH_TOKEN" ]; then
    if [ -t 0 ]; then
      read -r -s -p "FRP auth token: " AUTH_TOKEN
      echo
    fi
  fi

  if [ "$APPLY" = "yes" ] && [ -z "$AUTH_TOKEN" ]; then
    echo "Missing FRP auth token. Set FRPS_AUTH_TOKEN, pass --token-file, or run interactively." >&2
    exit 2
  fi

  if [ -z "$AUTH_TOKEN" ]; then
    AUTH_TOKEN="<runtime-token>"
  fi
}

install_frps_if_needed() {
  local current_version archive tmpdir extracted
  current_version="$("$INSTALL_BIN" --version 2>/dev/null || true)"

  if [ "$current_version" = "$FRP_VERSION" ]; then
    echo "Using existing $INSTALL_BIN version $current_version"
    return
  fi

  archive="$(detect_archive_name)"
  if [ -z "$DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${archive}"
  fi

  if [ "$APPLY" != "yes" ]; then
    echo "+ would install frps $FRP_VERSION from $DOWNLOAD_URL to $INSTALL_BIN"
    return
  fi

  command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
  command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 2; }
  if [ -n "$TAR_SHA256" ]; then
    command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required when --sha256 is used" >&2; exit 2; }
  fi

  TMPDIR_TO_CLEAN="$(mktemp -d)"
  tmpdir="$TMPDIR_TO_CLEAN"

  run curl -fL --retry 5 --connect-timeout 20 -o "$tmpdir/$archive" "$DOWNLOAD_URL"
  if [ -n "$TAR_SHA256" ]; then
    echo "${TAR_SHA256}  $tmpdir/$archive" | sha256sum -c -
  fi

  run tar -xzf "$tmpdir/$archive" -C "$tmpdir"
  extracted="$(find "$tmpdir" -type f -name frps | head -n 1)"
  if [ -z "$extracted" ]; then
    echo "Downloaded archive did not contain frps." >&2
    exit 2
  fi

  run sudo install -m 0755 "$extracted" "$INSTALL_BIN"
  current_version="$("$INSTALL_BIN" --version 2>/dev/null || true)"
  if [ "$current_version" != "$FRP_VERSION" ]; then
    echo "Installed frps version mismatch. Expected $FRP_VERSION, got ${current_version:-unknown}." >&2
    exit 1
  fi
  rm -rf "$tmpdir"
  TMPDIR_TO_CLEAN=""
}

validate_port "$BIND_PORT"
SERVICE_NAME="$(basename "$SERVICE_PATH")"
load_token

echo "Mode: $([ "$APPLY" = yes ] && echo apply || echo dry-run)"
echo "frps version: $FRP_VERSION"
echo "bind port: $BIND_PORT"
echo "allow ports: $ALLOW_PORTS"

install_frps_if_needed

write_file "$CONFIG_PATH" 0600 <<EOF
bindPort = $BIND_PORT

auth.method = "token"
auth.token = $(toml_string "$AUTH_TOKEN")
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.force = true
transport.tcpMux = false

log.to = $(toml_string "$LOG_PATH")
log.level = "info"
log.maxDays = 7

$(allow_ports_toml "$ALLOW_PORTS")
EOF

write_file "$SERVICE_PATH" 0644 <<EOF
[Unit]
Description=CZ CloudService frps
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_BIN -c $CONFIG_PATH
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

if [ "$APPLY" = "yes" ]; then
  run sudo systemctl daemon-reload
  run sudo systemctl enable --now "$SERVICE_NAME"
  run sudo systemctl --no-pager --full status "$SERVICE_NAME"
else
  echo "+ would run: sudo systemctl daemon-reload"
  echo "+ would run: sudo systemctl enable --now $SERVICE_NAME"
fi

echo "Next verification:"
echo "  systemctl is-enabled $SERVICE_NAME && systemctl is-active $SERVICE_NAME"
echo "  $INSTALL_BIN --version"
echo "  ss -tlnp | grep frps"
