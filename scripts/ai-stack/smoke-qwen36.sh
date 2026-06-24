#!/usr/bin/env bash
set -euo pipefail

HOST="${AI_BIND_HOST:-192.168.100.12}"
PORT="${QWEN_PORT:-8000}"
MODEL="${QWEN_MODEL:-qwen3.6-35b-a3b}"
RUN_LLM="${RUN_LLM:-/home/ubuntu/ai-stack/bin/run-llm.sh}"
PYTHON_BIN="${PYTHON_BIN:-/home/ubuntu/ai-stack/venv/bin/python}"
API_KEY="${AI_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  if [ ! -f "$RUN_LLM" ]; then
    echo "Missing $RUN_LLM and AI_API_KEY is not set." >&2
    exit 2
  fi
  API_KEY="$(grep -oE -- '--api-key +[^ ]+' "$RUN_LLM" | awk '{print $2}' | tail -1 || true)"
fi

if [ -z "$API_KEY" ]; then
  echo "Could not read API key. Set AI_API_KEY or check $RUN_LLM." >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

post_json() {
  local path="$1"
  local output="$2"
  curl -sS --max-time 180 -o "$output" -w '%{http_code}' \
    "http://${HOST}:${PORT}/v1/chat/completions" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H 'Content-Type: application/json' \
    -d @"$path"
}

echo "MODELS"
models_code="$(curl -sS --connect-timeout 2 --max-time 20 -o "$tmpdir/models.json" -w '%{http_code}' \
  "http://${HOST}:${PORT}/v1/models" -H "Authorization: Bearer ${API_KEY}" || true)"
echo "models_http=${models_code}"
if [ "$models_code" = "200" ]; then
  "$PYTHON_BIN" - "$tmpdir/models.json" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1]))
print("models=" + ",".join(item.get("id", "") for item in data.get("data", [])))
PY
fi

cat > "$tmpdir/text.json" <<JSON
{"model":"${MODEL}","messages":[{"role":"user","content":"请只输出一个数字，不要解释：1+1=?"}],"max_tokens":512,"temperature":0}
JSON

echo "TEXT"
text_code="$(post_json "$tmpdir/text.json" "$tmpdir/text.out")"
echo "text_http=${text_code}"
"$PYTHON_BIN" - "$tmpdir/text.out" <<'PY'
import json
import re
import sys
data = json.load(open(sys.argv[1]))
if "error" in data:
    print("error=" + str(data["error"])[:500])
    raise SystemExit(1)
choice = data.get("choices", [{}])[0]
msg = choice.get("message", {})
print("model=" + data.get("model", ""))
print("finish=" + str(choice.get("finish_reason")))
content = msg.get("content") or ""
print("content=" + content.replace("\n", " ")[:500])
if not re.fullmatch(r'[\s`"“”答案:：。.!！]*(2|２)[\s`"“”答案:：。.!！]*', content):
    print("validation=failed_missing_2")
    raise SystemExit(1)
PY

cat > "$tmpdir/image.json" <<JSON
{
  "model": "${MODEL}",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "请直接回答，不要推理过程：这张小图片主要是什么颜色？"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="}}
    ]
  }],
  "max_tokens": 128,
  "temperature": 0
}
JSON

echo "IMAGE"
image_code="$(post_json "$tmpdir/image.json" "$tmpdir/image.out")"
echo "image_http=${image_code}"
"$PYTHON_BIN" - "$tmpdir/image.out" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1]))
if "error" in data:
    print("error=" + str(data["error"])[:500])
    raise SystemExit(1)
choice = data.get("choices", [{}])[0]
msg = choice.get("message", {})
print("model=" + data.get("model", ""))
print("finish=" + str(choice.get("finish_reason")))
content = msg.get("content") or ""
print("content=" + content.replace("\n", " ")[:500])
normalized = content.strip().lower()
negative_markers = ("不", "不是", "not", "not white")
has_white = "白" in content or "white" in normalized
has_negation = any(marker in normalized for marker in negative_markers)
if not has_white or has_negation:
    print("validation=failed_missing_white")
    raise SystemExit(1)
PY
