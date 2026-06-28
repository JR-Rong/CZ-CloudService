#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <username> <initial-password> [display-name]" >&2
  exit 1
fi

username="$1"
password="$2"
display_name="${3:-$username}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
deploy_dir="${DEPLOY_DIR:-$repo_root/deploy/nextcloud-frp}"
env_file="${ENV_FILE:-$deploy_dir/.env}"
compose_file="${COMPOSE_FILE:-$deploy_dir/docker-compose.yml}"
employee_group="${NEXTCLOUD_EMPLOYEE_GROUP:-employees}"
compose=(docker compose --env-file "$env_file" -f "$compose_file" --project-directory "$deploy_dir")

if [[ ! -f "$env_file" ]]; then
  echo "Missing env file: $env_file" >&2
  exit 1
fi

"${compose[@]}" exec -T -u www-data nextcloud php occ group:add "$employee_group" >/dev/null 2>&1 || true

if "${compose[@]}" exec -T -u www-data nextcloud php occ user:info "$username" >/dev/null 2>&1; then
  echo "User already exists: $username" >&2
  exit 1
fi

"${compose[@]}" exec -T -u www-data -e OC_PASS="$password" nextcloud php occ user:add \
  --password-from-env \
  --display-name "$display_name" \
  --group "$employee_group" \
  "$username"

echo "Created Nextcloud user '$username' in group '$employee_group'."
