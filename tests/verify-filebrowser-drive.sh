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
  if ! grep -Eq -- "$pattern" "$root_dir/$path"; then
    echo "missing pattern in $path: $pattern" >&2
    exit 1
  fi
}

require_file scripts/windows/install-filebrowser-drive.ps1
require_file scripts/windows/setup-cloud-drive-frpc.ps1
require_file scripts/unix/deploy-filebrowser-drive-remote.sh
require_file patches/filebrowser/cz-spaces-v2.63.15.patch
require_file docs/filebrowser/windows-filebrowser-drive-deployment.md
require_file docs/deployment-change-log.md
require_file README.md

require_grep '\$Port = "2233"' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$Locale = "zh-cn"' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$WebPassword = "123456"' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$BrandingDir = Join-Path \$InstallDir "branding"' scripts/windows/install-filebrowser-drive.ps1
require_grep 'custom\.css' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$InitialUser = @\(\)' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$InitialUser -split ","' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$MinimumPasswordLength = 6' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$SyncTaskName = "CZCloudDriveWorkspaceSync"' scripts/windows/install-filebrowser-drive.ps1
require_grep '\[switch\]\$SyncOnly' scripts/windows/install-filebrowser-drive.ps1
require_grep '0x5171, 0x4EAB, 0x7A7A, 0x95F4' scripts/windows/install-filebrowser-drive.ps1
require_grep '0x79C1, 0x4EBA, 0x7A7A, 0x95F4' scripts/windows/install-filebrowser-drive.ps1
require_grep 'function Ensure-UserWorkspace' scripts/windows/install-filebrowser-drive.ps1
require_grep 'function Ensure-RootWorkspace' scripts/windows/install-filebrowser-drive.ps1
require_grep 'function Set-FileBrowserPasswordHash' scripts/windows/install-filebrowser-drive.ps1
require_grep 'function Sync-ExistingUserWorkspaces' scripts/windows/install-filebrowser-drive.ps1
require_grep 'function Sync-ExistingUserWorkspacesViaApi' scripts/windows/install-filebrowser-drive.ps1
require_grep 'users", "ls"' scripts/windows/install-filebrowser-drive.ps1
require_grep 'Invoke-RestMethod -Method Post -Uri "\$LocalBaseUrl/api/login"' scripts/windows/install-filebrowser-drive.ps1
require_grep '-Method Put' scripts/windows/install-filebrowser-drive.ps1
require_grep 'current_password = \$WebPassword' scripts/windows/install-filebrowser-drive.ps1
require_grep '\$ExePath hash \$Password' scripts/windows/install-filebrowser-drive.ps1
require_grep 'WriteAllBytes' scripts/windows/install-filebrowser-drive.ps1
require_grep 'mklink /D' scripts/windows/install-filebrowser-drive.ps1
require_grep 'Ensure-RootWorkspace' scripts/windows/install-filebrowser-drive.ps1
require_grep '--perm\.admin' scripts/windows/install-filebrowser-drive.ps1
require_grep '--scope' scripts/windows/install-filebrowser-drive.ps1
require_grep '--locale' scripts/windows/install-filebrowser-drive.ps1
require_grep '--branding\.files \$BrandingDir' scripts/windows/install-filebrowser-drive.ps1
require_grep 'New-ScheduledTaskAction' scripts/windows/install-filebrowser-drive.ps1
require_grep 'RepetitionInterval' scripts/windows/install-filebrowser-drive.ps1

require_grep 'CZ_DRIVE_HOST' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'CZ_FRONTEND_BUILD_MODE' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'cz-spaces-v2\.63\.15\.patch' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'pnpm run build' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'GOOS=windows' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'setup-cloud-drive-frpc\.ps1' scripts/unix/deploy-filebrowser-drive-remote.sh
require_grep 'toPrivateSpace\|toSharedSpace' scripts/unix/deploy-filebrowser-drive-remote.sh

require_grep 'toPrivateSpace' patches/filebrowser/cz-spaces-v2.63.15.patch
require_grep 'toSharedSpace' patches/filebrowser/cz-spaces-v2.63.15.patch
require_grep 'sharedSiblingRoot' patches/filebrowser/cz-spaces-v2.63.15.patch
require_grep 'user workspace shared sibling symlink is allowed' patches/filebrowser/cz-spaces-v2.63.15.patch

require_grep '\$Port = "2233"' scripts/windows/setup-cloud-drive-frpc.ps1
require_grep 'CZCloudDriveFrpc' scripts/windows/setup-cloud-drive-frpc.ps1
require_grep 'frpc-cloud-drive\.toml' scripts/windows/setup-cloud-drive-frpc.ps1
require_grep 'localPort = \$Port' scripts/windows/setup-cloud-drive-frpc.ps1
require_grep 'remotePort = \$Port' scripts/windows/setup-cloud-drive-frpc.ps1
require_grep 'auth\.token = "\$authToken"' scripts/windows/setup-cloud-drive-frpc.ps1

require_grep 'Windows File Browser Drive' README.md
require_grep 'install-filebrowser-drive\.ps1' README.md
require_grep 'setup-cloud-drive-frpc\.ps1' README.md
require_grep '-Port 2233' README.md
require_grep 'default password `123456`' README.md
require_grep 'alice:UserPassword123!,bob:UserPassword123!' README.md
require_grep 'sidebar.*私人空间.*共享空间|私人空间.*共享空间.*sidebar' README.md
require_grep 'zh-cn' README.md
require_grep 'shared-space' README.md
require_grep 'private-space' README.md
require_grep 'CZCloudDriveWorkspaceSync' README.md
require_grep 'deploy-filebrowser-drive-remote\.sh' README.md
require_grep 'Windows File Browser 网盘部署说明' docs/filebrowser/windows-filebrowser-drive-deployment.md
require_grep '部署改动总览' docs/deployment-change-log.md

echo "filebrowser drive deployment assets verified"
