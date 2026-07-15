#!/usr/bin/env bash
set -euo pipefail

IMAGE="${HERMES_IMAGE:-hermes:latest}"
NAME="${HERMES_CONTRACT_CONTAINER:-hermes-contract-test}"
VOLUME="${HERMES_CONTRACT_VOLUME:-hermes-contract-test-data}"
BASE_URL="${LOCAL_LLM_BASE_URL:-http://192.168.100.12:8000/v1}"
MODEL="${LOCAL_LLM_MODEL:-qwen3.6-35b-a3b}"
API_KEY="${AI_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  echo "AI_API_KEY is required at runtime and must not be committed." >&2
  exit 2
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

profile_json=""
env_file="$(mktemp)"

cleanup_runtime_files() {
  rm -f "$env_file"
  if [ -n "$profile_json" ]; then
    rm -f "$profile_json"
  fi
}

trap 'cleanup_runtime_files; cleanup' EXIT

require_json_object() {
  local label="$1"
  local payload="$2"
  printf '%s\n' "$payload"
  PAYLOAD="$payload" node -e '
const value = JSON.parse(process.env.PAYLOAD || "");
if (!value || Array.isArray(value) || typeof value !== "object") {
  process.exit(1);
}
' || {
    echo "$label did not return a JSON object" >&2
    exit 1
  }
}

require_profile_count() {
  local label="$1"
  local payload="$2"
  local slug="$3"
  local expected="$4"
  printf '%s\n' "$payload"
  PAYLOAD="$payload" SLUG="$slug" EXPECTED="$expected" node -e '
const value = JSON.parse(process.env.PAYLOAD || "");
const profiles = Array.isArray(value.profiles) ? value.profiles : [];
const count = profiles.filter((profile) => profile && profile.slug === process.env.SLUG).length;
if (count !== Number(process.env.EXPECTED)) {
  process.exit(1);
}
' || {
    echo "$label expected $expected profile(s) with slug $slug" >&2
    exit 1
  }
}

require_delete_missing() {
  local label="$1"
  local payload="$2"
  printf '%s\n' "$payload"
  PAYLOAD="$payload" node -e '
const value = JSON.parse(process.env.PAYLOAD || "");
if (!value || Array.isArray(value) || typeof value !== "object" || value.missing !== true) {
  process.exit(1);
}
' || {
    echo "$label expected missing: true" >&2
    exit 1
  }
}

require_health_ready_private_model() {
  local payload="$1"
  printf '%s\n' "$payload"
  PAYLOAD="$payload" BASE_URL="$BASE_URL" MODEL="$MODEL" node -e '
const value = JSON.parse(process.env.PAYLOAD || "");
if (!value || Array.isArray(value) || typeof value !== "object") {
  process.exit(1);
}
const privateModel = value.privateModel || {};
if (
  value.status !== "ready" ||
  privateModel.baseUrl !== process.env.BASE_URL ||
  privateModel.model !== process.env.MODEL ||
  privateModel.privateOnly !== true
) {
  process.exit(1);
}
' || {
    echo "health did not report ready private model metadata" >&2
    exit 1
  }
}

require_no_secret() {
  local label="$1"
  local payload="$2"
  if [ -n "$API_KEY" ] && printf '%s' "$payload" | grep -F "$API_KEY" >/dev/null; then
    echo "$label leaked API key" >&2
    exit 1
  fi
}

cat > "$env_file" <<ENV
OPENAI_BASE_URL=$BASE_URL
OPENAI_API_BASE=$BASE_URL
OPENAI_MODEL=$MODEL
LOCAL_LLM_MODEL=$MODEL
OPENAI_API_KEY=$API_KEY
HERMES_PRIVATE_MODEL_ONLY=1
HERMES_OWNER_ID=contract-test
HERMES_EMPLOYEE_USERNAME=contract-test
ENV
chmod 600 "$env_file" 2>/dev/null || true

cleanup

docker run -d \
  --name "$NAME" \
  --env-file "$env_file" \
  -v "$VOLUME:/data" \
  "$IMAGE" >/dev/null

docker exec "$NAME" command -v hermes-profilectl >/dev/null
docker exec "$NAME" test ! -S /var/run/docker.sock || {
  echo "container exposes Docker socket" >&2
  exit 1
}

health="$(docker exec "$NAME" hermes-profilectl health --json)"
require_health_ready_private_model "$health"

profile_json="$(mktemp)"

cat > "$profile_json" <<JSON
{
  "version": 1,
  "slug": "smoke",
  "displayName": "Smoke",
  "description": "Contract smoke profile.",
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "$BASE_URL",
    "model": "$MODEL",
    "privateOnly": true
  },
  "bindings": [],
  "resources": []
}
JSON

list_before_output="$(docker exec "$NAME" hermes-profilectl list --json)"
require_json_object "list before create" "$list_before_output"
create_output="$(docker exec -i "$NAME" hermes-profilectl create --slug smoke --name Smoke --config-json - < "$profile_json")"
require_json_object "create" "$create_output"
create_again_output="$(docker exec -i "$NAME" hermes-profilectl create --slug smoke --name Smoke --config-json - < "$profile_json")"
require_json_object "create idempotent" "$create_again_output"
list_after_output="$(docker exec "$NAME" hermes-profilectl list --json)"
require_json_object "list after create" "$list_after_output"
require_profile_count "list after create" "$list_after_output" smoke 1
start_output="$(docker exec "$NAME" hermes-profilectl start smoke)"
require_json_object "start" "$start_output"
restart_output="$(docker exec "$NAME" hermes-profilectl restart smoke)"
require_json_object "restart" "$restart_output"
stop_output="$(docker exec "$NAME" hermes-profilectl stop smoke)"
require_json_object "stop" "$stop_output"
delete_output="$(docker exec "$NAME" hermes-profilectl delete smoke)"
require_json_object "delete" "$delete_output"
list_after_delete_output="$(docker exec "$NAME" hermes-profilectl list --json)"
require_json_object "list after delete" "$list_after_delete_output"
require_profile_count "list after delete" "$list_after_delete_output" smoke 0
delete_missing_output="$(docker exec "$NAME" hermes-profilectl delete smoke)"
require_json_object "delete missing" "$delete_missing_output"
require_delete_missing "delete missing" "$delete_missing_output"

all_outputs="${health}
${list_before_output}
${create_output}
${create_again_output}
${list_after_output}
${start_output}
${restart_output}
${stop_output}
${delete_output}
${list_after_delete_output}
${delete_missing_output}"
require_no_secret "contract command outputs" "$all_outputs"

echo "Hermes image contract smoke passed for $IMAGE"
