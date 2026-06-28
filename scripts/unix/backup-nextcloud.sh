#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
deploy_dir="${DEPLOY_DIR:-$repo_root/deploy/nextcloud-frp}"
env_file="${ENV_FILE:-$deploy_dir/.env}"
compose_file="${COMPOSE_FILE:-$deploy_dir/docker-compose.yml}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing env file: $env_file" >&2
  echo "Copy deploy/nextcloud-frp/.env.example to .env and fill secrets first." >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local default_value="$2"
  local value
  value="$(grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf '%s\n' "$value"
}

nextcloud_root="${NEXTCLOUD_ROOT:-$(read_env_value NEXTCLOUD_ROOT ./data)}"
if [[ "$nextcloud_root" != /* ]]; then
  nextcloud_root="$deploy_dir/$nextcloud_root"
fi

backup_root="${BACKUP_ROOT:-$nextcloud_root/backups}"
backup_retention_days="${BACKUP_RETENTION_DAYS:-$(read_env_value BACKUP_RETENTION_DAYS 14)}"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$backup_root/$timestamp"
compose=(docker compose --env-file "$env_file" -f "$compose_file" --project-directory "$deploy_dir")
maintenance_enabled=0

run_occ() {
  "${compose[@]}" exec -T -u www-data nextcloud php occ "$@"
}

cleanup() {
  if [[ "$maintenance_enabled" == "1" ]]; then
    run_occ maintenance:mode --off >/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$backup_dir"

echo "Enabling Nextcloud maintenance mode..."
run_occ maintenance:mode --on >/dev/null
maintenance_enabled=1

echo "Dumping MariaDB..."
"${compose[@]}" exec -T db sh -c \
  'mariadb-dump --single-transaction --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  > "$backup_dir/nextcloud-database.sql"

echo "Archiving Nextcloud files and config..."
tar -C "$nextcloud_root" -czf "$backup_dir/nextcloud-files.tar.gz" \
  html custom_apps config data themes

echo "Capturing deployment metadata..."
{
  echo "created_at=$timestamp"
  echo "deploy_dir=$deploy_dir"
  echo "nextcloud_root=$nextcloud_root"
  "${compose[@]}" ps
} > "$backup_dir/manifest.txt"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$backup_dir"/nextcloud-* > "$backup_dir/SHA256SUMS"
else
  shasum -a 256 "$backup_dir"/nextcloud-* > "$backup_dir/SHA256SUMS"
fi

echo "Disabling Nextcloud maintenance mode..."
run_occ maintenance:mode --off >/dev/null
maintenance_enabled=0

echo "Pruning backups older than $backup_retention_days days..."
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +"$backup_retention_days" -exec rm -rf {} +

echo "Backup completed: $backup_dir"
