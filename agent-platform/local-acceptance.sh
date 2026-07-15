#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_URL="${PUBLIC_URL:-http://60.205.213.254:2444/}"
PUBLIC_HOST="${PUBLIC_HOST:-60.205.213.254}"
PUBLIC_PORT="${PUBLIC_PORT:-2444}"

run() {
  printf '\n[local-acceptance] %s\n' "$*"
  "$@"
}

cd "$REPO_ROOT"

run bash -n agent-platform/hermes-contract-smoke.sh scripts/cloud/setup-frps.sh scripts/cloud/check-frps-agent-platform.sh agent-platform/local-acceptance.sh

run bash scripts/cloud/setup-frps.sh --allow-ports 2222,2444,9000,9999 >/dev/null

(
  cd apps/ui
  run node --test --test-reporter=spec test/*.test.js
  run node --check src/server.js src/store.js src/docker.js src/secrets.js public/app.js ../../agent-platform/hermes-wrapper/hermes-profilectl.js
)

run git diff --check

if command -v pwsh >/dev/null 2>&1; then
  run pwsh -NoProfile -ExecutionPolicy Bypass -Command '
    $errors = $null
    foreach ($path in @(
      "scripts/windows/setup-frpc.ps1",
      "scripts/windows/setup-agent-platform.ps1",
      "scripts/windows/check-agent-platform.ps1"
    )) {
      [System.Management.Automation.PSParser]::Tokenize(
        (Get-Content $path -Raw),
        [ref]$errors
      ) | Out-Null
      if ($errors -and $errors.Count) {
        throw "$path has PowerShell parser errors"
      }
    }
  '
else
  printf '\n[local-acceptance] WARN: pwsh not found; PowerShell parser validation must run on Windows.\n'
fi

if [ "${RUN_PUBLIC_SMOKE:-0}" = "1" ]; then
  run nc -vz -w 5 "$PUBLIC_HOST" "$PUBLIC_PORT"
  run curl --noproxy '*' -i --max-time 10 "$PUBLIC_URL"
else
  printf '\n[local-acceptance] INFO: set RUN_PUBLIC_SMOKE=1 to check public FRP HTTP/TCP.\n'
fi

printf '\n[local-acceptance] INFO: DOCKER real-mode smoke is external and still requires:\n'
printf '  AI_API_KEY=<runtime-secret> HERMES_IMAGE=hermes:latest bash agent-platform/hermes-contract-smoke.sh\n'
