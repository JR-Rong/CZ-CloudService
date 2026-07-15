#!/usr/bin/env bash
set -euo pipefail

APPLY="no"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_SOURCE="${AI_CHAT_SOURCE:-$REPO_ROOT/apps/ai-chat}"
INSTALL_DIR="${AI_CHAT_INSTALL_DIR:-/home/ubuntu/ai-stack/ai-chat-web}"
SERVICE_PATH="${AI_CHAT_SERVICE_PATH:-/etc/systemd/system/ai-chat-web.service}"
ENV_PATH="${AI_CHAT_ENV_PATH:-/etc/default/ai-chat-web}"
SERVICE_USER="${AI_CHAT_SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${AI_CHAT_SERVICE_GROUP:-ubuntu}"
AI_CHAT_HOST="${AI_CHAT_HOST:-192.168.100.12}"
AI_CHAT_PORT="${AI_CHAT_PORT:-9999}"
AI_CHAT_LLM_BASE_URL="${AI_CHAT_LLM_BASE_URL:-http://192.168.100.12:8000}"
AI_CHAT_MODEL="${AI_CHAT_MODEL:-qwen3.6-35b-a3b}"
AI_CHAT_RUN_LLM="${AI_CHAT_RUN_LLM:-/home/ubuntu/ai-stack/bin/run-llm.sh}"
AI_CHAT_CONTEXT_LIMIT="${AI_CHAT_CONTEXT_LIMIT:-120000}"
AI_CHAT_WEB_TOKEN="${AI_CHAT_WEB_TOKEN:-}"
AI_CHAT_WEB_SEARCH_ENABLED="${AI_CHAT_WEB_SEARCH_ENABLED:-1}"
AI_CHAT_WEB_SEARCH_URL="${AI_CHAT_WEB_SEARCH_URL:-https://cn.bing.com/search?q={query}}"
AI_CHAT_WEB_SEARCH_FALLBACK_URLS="${AI_CHAT_WEB_SEARCH_FALLBACK_URLS:-https://www.marketwatch.com/rss/topstories,https://feeds.a.dj.com/rss/RSSMarketsMain.xml}"
AI_CHAT_WEB_SEARCH_MAX_RESULTS="${AI_CHAT_WEB_SEARCH_MAX_RESULTS:-5}"
AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS="${AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS:-8}"
AI_CHAT_IMAGE_GENERATION_URL="${AI_CHAT_IMAGE_GENERATION_URL:-}"
AI_CHAT_IMAGE_GENERATION_BACKEND="${AI_CHAT_IMAGE_GENERATION_BACKEND:-}"
AI_CHAT_IMAGE_CHECKPOINT="${AI_CHAT_IMAGE_CHECKPOINT:-Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors}"
AI_CHAT_IMAGE_SAMPLER="${AI_CHAT_IMAGE_SAMPLER:-dpmpp_2m_sde}"
AI_CHAT_IMAGE_SCHEDULER="${AI_CHAT_IMAGE_SCHEDULER:-karras}"
AI_CHAT_VIDEO_GENERATION_URL="${AI_CHAT_VIDEO_GENERATION_URL:-}"
AI_CHAT_VIDEO_GENERATION_BACKEND="${AI_CHAT_VIDEO_GENERATION_BACKEND:-}"
AI_CHAT_VIDEO_MODEL_PROFILE="${AI_CHAT_VIDEO_MODEL_PROFILE:-wan22-14b-lightx2v}"
AI_CHAT_MEDIA_API_KEY="${AI_CHAT_MEDIA_API_KEY:-}"
AI_CHAT_MEDIA_TIMEOUT_SECONDS="${AI_CHAT_MEDIA_TIMEOUT_SECONDS:-1800}"
AI_CHAT_MEDIA_BODY_LIMIT="${AI_CHAT_MEDIA_BODY_LIMIT:-30000000}"

usage() {
  cat <<'EOF'
Usage:
  setup-ai-chat-web.sh [--apply]

Installs the AI chat web gateway as:
  /home/ubuntu/ai-stack/ai-chat-web
  /etc/default/ai-chat-web
  /etc/systemd/system/ai-chat-web.service

The service listens on 192.168.100.12:9999 by default and proxies model calls
to the existing Qwen3.6 service at 192.168.100.12:8000. It reads the LLM API key
from /home/ubuntu/ai-stack/bin/run-llm.sh unless AI_CHAT_API_KEY is supplied in
the runtime environment.

Optional environment overrides:
  AI_CHAT_HOST=192.168.100.12
  AI_CHAT_PORT=9999
  AI_CHAT_LLM_BASE_URL=http://192.168.100.12:8000
  AI_CHAT_MODEL=qwen3.6-35b-a3b
  AI_CHAT_WEB_TOKEN=<optional-ui-token>
  AI_CHAT_WEB_SEARCH_ENABLED=1
  AI_CHAT_WEB_SEARCH_URL='https://cn.bing.com/search?q={query}'
  AI_CHAT_WEB_SEARCH_FALLBACK_URLS='https://www.marketwatch.com/rss/topstories,https://feeds.a.dj.com/rss/RSSMarketsMain.xml'
  AI_CHAT_IMAGE_GENERATION_URL=<internal-image-api-url>
  AI_CHAT_IMAGE_GENERATION_BACKEND=<generic|comfyui>
  AI_CHAT_IMAGE_CHECKPOINT=Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors
  AI_CHAT_IMAGE_SAMPLER=dpmpp_2m_sde
  AI_CHAT_IMAGE_SCHEDULER=karras
  AI_CHAT_VIDEO_GENERATION_URL=<internal-video-api-url>
  AI_CHAT_VIDEO_GENERATION_BACKEND=<generic|comfyui>
  AI_CHAT_VIDEO_MODEL_PROFILE=wan22-14b-lightx2v
  AI_CHAT_MEDIA_API_KEY=<optional-media-api-key>
  AI_CHAT_MEDIA_TIMEOUT_SECONDS=1800
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
    run sudo install -d -m 0755 "$(dirname "$path")"
    run sudo install -m "$mode" "$tmp" "$path"
  else
    echo "--- would write $path mode=$mode"
    sed -E \
      -e 's/(AI_CHAT_WEB_TOKEN=).*/\1<redacted-ui-token>/' \
      -e 's/(AI_CHAT_MEDIA_API_KEY=).*/\1<redacted-media-token>/' \
      "$tmp"
  fi
  rm -f "$tmp"
}

if [ ! -f "$APP_SOURCE/server.py" ] || [ ! -f "$APP_SOURCE/debug_search.py" ] || [ ! -f "$APP_SOURCE/public/index.html" ]; then
  echo "Missing AI chat web source under $APP_SOURCE" >&2
  exit 2
fi

run sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$INSTALL_DIR"
run sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$INSTALL_DIR/public"

if [ "$APPLY" = "yes" ]; then
  run sudo install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$APP_SOURCE/server.py" "$INSTALL_DIR/server.py"
  run sudo install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$APP_SOURCE/debug_search.py" "$INSTALL_DIR/debug_search.py"
  run sudo cp -R "$APP_SOURCE/public/." "$INSTALL_DIR/public/"
  run sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/public"
else
  echo "--- would install $APP_SOURCE/server.py, debug_search.py, and public assets into $INSTALL_DIR"
fi

write_file "$ENV_PATH" 0600 <<EOF
AI_CHAT_HOST=$AI_CHAT_HOST
AI_CHAT_PORT=$AI_CHAT_PORT
AI_CHAT_LLM_BASE_URL=$AI_CHAT_LLM_BASE_URL
AI_CHAT_MODEL=$AI_CHAT_MODEL
AI_CHAT_RUN_LLM=$AI_CHAT_RUN_LLM
AI_CHAT_CONTEXT_LIMIT=$AI_CHAT_CONTEXT_LIMIT
AI_CHAT_PUBLIC_DIR=$INSTALL_DIR/public
AI_CHAT_WEB_TOKEN=$AI_CHAT_WEB_TOKEN
AI_CHAT_WEB_SEARCH_ENABLED=$AI_CHAT_WEB_SEARCH_ENABLED
AI_CHAT_WEB_SEARCH_URL=$AI_CHAT_WEB_SEARCH_URL
AI_CHAT_WEB_SEARCH_FALLBACK_URLS=$AI_CHAT_WEB_SEARCH_FALLBACK_URLS
AI_CHAT_WEB_SEARCH_MAX_RESULTS=$AI_CHAT_WEB_SEARCH_MAX_RESULTS
AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS=$AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS
AI_CHAT_IMAGE_GENERATION_URL=$AI_CHAT_IMAGE_GENERATION_URL
AI_CHAT_IMAGE_GENERATION_BACKEND=$AI_CHAT_IMAGE_GENERATION_BACKEND
AI_CHAT_IMAGE_CHECKPOINT=$AI_CHAT_IMAGE_CHECKPOINT
AI_CHAT_IMAGE_SAMPLER=$AI_CHAT_IMAGE_SAMPLER
AI_CHAT_IMAGE_SCHEDULER=$AI_CHAT_IMAGE_SCHEDULER
AI_CHAT_VIDEO_GENERATION_URL=$AI_CHAT_VIDEO_GENERATION_URL
AI_CHAT_VIDEO_GENERATION_BACKEND=$AI_CHAT_VIDEO_GENERATION_BACKEND
AI_CHAT_VIDEO_MODEL_PROFILE=$AI_CHAT_VIDEO_MODEL_PROFILE
AI_CHAT_MEDIA_API_KEY=$AI_CHAT_MEDIA_API_KEY
AI_CHAT_MEDIA_TIMEOUT_SECONDS=$AI_CHAT_MEDIA_TIMEOUT_SECONDS
AI_CHAT_MEDIA_BODY_LIMIT=$AI_CHAT_MEDIA_BODY_LIMIT
EOF

write_file "$SERVICE_PATH" 0644 <<EOF
[Unit]
Description=CZ AI Chat Web Gateway
After=network-online.target ai-llm.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-$ENV_PATH
ExecStart=/usr/bin/python3 $INSTALL_DIR/server.py
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

run sudo systemctl daemon-reload
run sudo systemctl enable ai-chat-web.service
run sudo systemctl restart ai-chat-web.service

echo "Next checks:"
echo "  systemctl status ai-chat-web.service --no-pager -l"
echo "  curl -i http://$AI_CHAT_HOST:$AI_CHAT_PORT/health"
echo "  curl -i http://60.205.213.254:9999/ after frpc registers ai-chat-web-9999"
