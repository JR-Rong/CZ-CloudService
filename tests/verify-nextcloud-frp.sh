#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_file() {
  local path="$1"
  if [[ ! -f "$root_dir/$path" ]]; then
    echo "missing required file: $path" >&2
    exit 1
  fi
}

require_grep() {
  local pattern="$1"
  local path="$2"
  if ! grep -Eq "$pattern" "$root_dir/$path"; then
    echo "missing pattern in $path: $pattern" >&2
    exit 1
  fi
}

require_file deploy/nextcloud-frp/docker-compose.yml
require_file deploy/nextcloud-frp/.env.example
require_file deploy/nextcloud-frp/frpc.toml.example
require_file scripts/unix/backup-nextcloud.sh
require_file docs/nextcloud/private-drive-frp-deployment.md

require_grep 'image:[[:space:]]+nextcloud:stable-apache' deploy/nextcloud-frp/docker-compose.yml
require_grep 'image:[[:space:]]+mariadb:lts' deploy/nextcloud-frp/docker-compose.yml
require_grep 'image:[[:space:]]+redis:.*alpine' deploy/nextcloud-frp/docker-compose.yml
require_grep 'image:[[:space:]]+fatedier/frpc:v0\.69\.1' deploy/nextcloud-frp/docker-compose.yml
require_grep 'NEXTCLOUD_TRUSTED_DOMAINS' deploy/nextcloud-frp/docker-compose.yml
require_grep 'OVERWRITEHOST' deploy/nextcloud-frp/docker-compose.yml
require_grep 'OVERWRITEPROTOCOL' deploy/nextcloud-frp/docker-compose.yml
require_grep 'OVERWRITECLIURL' deploy/nextcloud-frp/docker-compose.yml
require_grep 'REDIS_HOST' deploy/nextcloud-frp/docker-compose.yml
require_grep 'cron' deploy/nextcloud-frp/docker-compose.yml

require_grep 'serverAddr[[:space:]]*=[[:space:]]*"60\.205\.213\.254"' deploy/nextcloud-frp/frpc.toml.example
require_grep 'serverPort[[:space:]]*=[[:space:]]*7000' deploy/nextcloud-frp/frpc.toml.example
require_grep 'remotePort[[:space:]]*=[[:space:]]*2233' deploy/nextcloud-frp/frpc.toml.example
require_grep 'localPort[[:space:]]*=[[:space:]]*80' deploy/nextcloud-frp/frpc.toml.example

require_grep 'mariadb-dump' scripts/unix/backup-nextcloud.sh
require_grep 'exec -T' scripts/unix/backup-nextcloud.sh
require_grep 'BACKUP_RETENTION_DAYS' scripts/unix/backup-nextcloud.sh

require_grep '60\.205\.213\.254:2233' docs/nextcloud/private-drive-frp-deployment.md
require_grep 'NEXTCLOUD_TRUSTED_DOMAINS' docs/nextcloud/private-drive-frp-deployment.md
require_grep 'OVERWRITEHOST' docs/nextcloud/private-drive-frp-deployment.md
require_grep 'frps allowPorts' docs/nextcloud/private-drive-frp-deployment.md

echo "nextcloud frp deployment assets verified"
