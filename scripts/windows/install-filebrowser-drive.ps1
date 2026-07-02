param(
  [string]$InstallDir = "C:\CZCloudDrive",
  [string]$Port = "2233",
  [string]$Version = "v2.63.15",
  [string]$AdminUser = "admin",
  [string]$AdminPassword = "",
  [string]$WebPassword = "123456",
  [string]$Locale = "zh-cn",
  [string]$BrandingName = "CZ Cloud Drive",
  [string]$SharedFolderName = "",
  [string]$PrivateFolderName = "",
  [string]$UsersRootName = "_users",
  [string]$SharedRootName = "_shared",
  [string[]]$InitialUser = @(),
  [uint32]$MinimumPasswordLength = 6,
  [switch]$ResetDatabase,
  [switch]$SyncOnly
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Join-Chars([int[]]$Codes) {
  return -join ($Codes | ForEach-Object { [char]$_ })
}

if ([string]::IsNullOrWhiteSpace($SharedFolderName)) {
  $SharedFolderName = Join-Chars @(0x5171, 0x4EAB, 0x7A7A, 0x95F4)
}
if ([string]::IsNullOrWhiteSpace($PrivateFolderName)) {
  $PrivateFolderName = Join-Chars @(0x79C1, 0x4EBA, 0x7A7A, 0x95F4)
}
$DataDir = Join-Path $InstallDir "data"
$LogDir = Join-Path $InstallDir "logs"
$BrandingDir = Join-Path $InstallDir "branding"
$CustomCssPath = Join-Path $BrandingDir "custom.css"
$DbPath = Join-Path $InstallDir "filebrowser.db"
$ZipPath = Join-Path $InstallDir "filebrowser.zip"
$ExePath = Join-Path $InstallDir "filebrowser.exe"
$TaskName = "CZCloudDrive"
$SyncTaskName = "CZCloudDriveWorkspaceSync"
$UsersRootDir = Join-Path $DataDir $UsersRootName
$SharedDir = Join-Path $DataDir $SharedRootName
$LocalBaseUrl = "http://127.0.0.1:$Port"

function ConvertTo-FileName([string]$Value) {
  $invalid = [Regex]::Escape((-join [System.IO.Path]::GetInvalidFileNameChars()))
  return ($Value -replace "[$invalid]", "_").Trim()
}

function Remove-ReparsePointOrDirectory([string]$Path) {
  if (!(Test-Path $Path)) {
    return
  }
  $item = Get-Item $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    cmd.exe /c "rmdir `"$Path`"" | Out-Null
  } else {
    Remove-Item $Path -Recurse -Force
  }
}

function Ensure-UserWorkspace([string]$Username) {
  $homeName = ConvertTo-FileName $Username
  if ([string]::IsNullOrWhiteSpace($homeName)) {
    throw "Username '$Username' cannot be converted to a workspace folder name"
  }

  $userRoot = Join-Path $UsersRootDir $homeName
  $privateDir = Join-Path $userRoot $PrivateFolderName
  $sharedLink = Join-Path $userRoot $SharedFolderName

  New-Item -ItemType Directory -Force -Path $userRoot, $privateDir, $SharedDir | Out-Null
  if (Test-Path $sharedLink) {
    $current = Get-Item $sharedLink -Force
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      throw "Shared entry already exists and is not a directory symbolic link: $sharedLink"
    }
    Remove-ReparsePointOrDirectory $sharedLink
  }
  cmd.exe /c "mklink /D `"$sharedLink`" `"$SharedDir`"" | Out-Null

  return "/$UsersRootName/$homeName"
}

function Ensure-RootWorkspace {
  $rootPrivateDir = Join-Path $DataDir $PrivateFolderName
  $rootSharedLink = Join-Path $DataDir $SharedFolderName

  New-Item -ItemType Directory -Force -Path $rootPrivateDir, $SharedDir | Out-Null
  if (Test-Path $rootSharedLink) {
    $current = Get-Item $rootSharedLink -Force
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      throw "Root shared entry already exists and is not a directory symbolic link: $rootSharedLink"
    }
    Remove-ReparsePointOrDirectory $rootSharedLink
  }
  cmd.exe /c "mklink /D `"$rootSharedLink`" `"$SharedDir`"" | Out-Null
}

function Test-FileBrowserUserExists([string]$Username) {
  $stdoutPath = Join-Path $LogDir "user-find.out"
  $stderrPath = Join-Path $LogDir "user-find.err"
  $process = Start-Process `
    -FilePath $ExePath `
    -ArgumentList @("-d", $DbPath, "users", "find", $Username) `
    -Wait `
    -PassThru `
    -NoNewWindow `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
  return $process.ExitCode -eq 0
}

function Invoke-FileBrowser([string[]]$Arguments) {
  & $ExePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "filebrowser.exe failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
  }
}

function New-TemporaryPassword {
  return "Temp-$([Guid]::NewGuid().ToString("N"))-Aa1!"
}

function Set-FileBrowserPasswordHash([string]$Username, [string]$Password) {
  $hash = (& $ExePath hash $Password | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hash)) {
    throw "Failed to generate bcrypt hash for user '$Username'"
  }

  $bytes = [System.IO.File]::ReadAllBytes($DbPath)
  $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
  $escapedUser = [Regex]::Escape($Username)
  $matches = [Regex]::Matches($ascii, "\{`"id`":\d+,`"username`":`"$escapedUser`",`"password`":`"(?<hash>\`$2[abxy]\`$[^`"]+)`"")
  if ($matches.Count -eq 0) {
    throw "Could not find user '$Username' in File Browser database"
  }

  $replaced = 0
  foreach ($match in $matches) {
    $oldHash = $match.Groups["hash"].Value
    if ($oldHash.Length -ne $hash.Length) {
      throw "Refusing to replace password hash with different length for user '$Username'"
    }

    $index = 0
    while ($true) {
      $index = $ascii.IndexOf($oldHash, $index, [StringComparison]::Ordinal)
      if ($index -lt 0) {
        break
      }

      $hashBytes = [System.Text.Encoding]::ASCII.GetBytes($hash)
      [Array]::Copy($hashBytes, 0, $bytes, $index, $hashBytes.Length)
      $replaced++
      $index += $oldHash.Length
    }
  }

  if ($replaced -eq 0) {
    throw "Could not locate password hash bytes for user '$Username'"
  }

  Copy-Item $DbPath "$DbPath.bak" -Force
  [System.IO.File]::WriteAllBytes($DbPath, $bytes)
}

function Ensure-FileBrowserUser(
  [string]$Username,
  [string]$Password,
  [string]$Scope,
  [bool]$IsAdmin
) {
  $patchPasswordHash = $IsAdmin -and ![string]::IsNullOrEmpty($Password)
  $cliPassword = $Password
  if ($patchPasswordHash) {
    $cliPassword = New-TemporaryPassword
  }

  $fbArgs = @("-d", $DbPath, "users")
  if (Test-FileBrowserUserExists $Username) {
    $fbArgs += @("update", $Username, "--scope", $Scope, "--locale", $Locale)
    if (![string]::IsNullOrEmpty($Password) -and !$patchPasswordHash) {
      $fbArgs += @("--password", $Password)
    }
  } else {
    if ([string]::IsNullOrEmpty($cliPassword)) {
      throw "Password is required when creating user '$Username'"
    }
    $fbArgs += @("add", $Username, $cliPassword, "--scope", $Scope, "--locale", $Locale)
  }

  if ($IsAdmin) {
    $fbArgs += "--perm.admin"
  }

  Invoke-FileBrowser $fbArgs

  if ($patchPasswordHash) {
    Set-FileBrowserPasswordHash -Username $Username -Password $Password
  }
}

function Get-FileBrowserUsers {
  $stdoutPath = Join-Path $LogDir "users-list.out"
  $stderrPath = Join-Path $LogDir "users-list.err"
  $process = Start-Process `
    -FilePath $ExePath `
    -ArgumentList @("-d", $DbPath, "users", "ls") `
    -Wait `
    -PassThru `
    -NoNewWindow `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
  if ($process.ExitCode -ne 0) {
    throw "Failed to list File Browser users"
  }

  $users = @()
  foreach ($line in Get-Content $stdoutPath) {
    if ($line -match '^\s*\d+\s+(\S+)\s+(\S+)\s+') {
      $users += [pscustomobject]@{
        Username = $matches[1]
        Scope = $matches[2]
      }
    }
  }
  return $users
}

function Sync-ExistingUserWorkspaces {
  foreach ($user in Get-FileBrowserUsers) {
    if ($user.Username -eq $AdminUser) {
      continue
    }

    $scope = Ensure-UserWorkspace $user.Username
    Ensure-FileBrowserUser -Username $user.Username -Password "" -Scope $scope -IsAdmin $false
  }
}

function Sync-ExistingUserWorkspacesViaApi {
  try {
    $loginBody = @{ username = $AdminUser; password = $WebPassword } | ConvertTo-Json -Compress
    $token = Invoke-RestMethod -Method Post -Uri "$LocalBaseUrl/api/login" -ContentType "application/json" -Body $loginBody -TimeoutSec 10
  } catch {
    Write-Output "File Browser API is not ready; skipping workspace sync."
    return
  }

  $headers = @{ "X-Auth" = $token }
  $users = Invoke-RestMethod -Method Get -Uri "$LocalBaseUrl/api/users" -Headers $headers -TimeoutSec 20
  foreach ($user in $users) {
    if ($user.username -eq $AdminUser) {
      continue
    }

    $scope = Ensure-UserWorkspace $user.username
    $user.scope = $scope
    $user.locale = $Locale
    $body = @{
      what = "user"
      which = @("scope", "locale")
      current_password = $WebPassword
      data = $user
    } | ConvertTo-Json -Depth 16 -Compress

    Invoke-RestMethod `
      -Method Put `
      -Uri "$LocalBaseUrl/api/users/$($user.id)" `
      -Headers $headers `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 20 | Out-Null
  }
}

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, $LogDir, $BrandingDir, $UsersRootDir, $SharedDir | Out-Null
$customCss = @"
/* Reserved for CZ Cloud Drive branding. Sidebar space buttons are compiled into the frontend. */
"@
Set-Content -Path $CustomCssPath -Value $customCss -Encoding UTF8

if ($SyncOnly) {
  Sync-ExistingUserWorkspacesViaApi
  Write-Output "Workspace sync completed."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
  throw "AdminPassword is required for installation because Windows scheduled tasks need the Windows account password."
}

$downloadUrl = "https://github.com/filebrowser/filebrowser/releases/download/$Version/windows-amd64-filebrowser.zip"
if (!(Test-Path $ExePath)) {
  if (!(Test-Path $ZipPath)) {
    Write-Output "Downloading File Browser $Version"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $ZipPath -UseBasicParsing
  } else {
    Write-Output "Using existing archive $ZipPath"
  }
  Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force
}

if (!(Test-Path $ExePath)) {
  throw "filebrowser.exe was not found at $ExePath"
}

Write-Output "File Browser version:"
& $ExePath version

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  if ($listener.OwningProcess -and $listener.OwningProcess -ne 0) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Output "Stopping process on port ${Port}: $($proc.ProcessName) [$($proc.Id)]"
      Stop-Process -Id $proc.Id -Force
    }
  }
}

if ($ResetDatabase -and (Test-Path $DbPath)) {
  Remove-Item $DbPath -Force
}

if (!(Test-Path $DbPath)) {
  & $ExePath -d $DbPath config init
}

& $ExePath -d $DbPath config set `
  --address "0.0.0.0" `
  --port $Port `
  --root $DataDir `
  --locale $Locale `
  --minimumPasswordLength $MinimumPasswordLength `
  --branding.name $BrandingName `
  --branding.files $BrandingDir

Ensure-FileBrowserUser -Username $AdminUser -Password $WebPassword -Scope "/" -IsAdmin $true
Ensure-RootWorkspace

foreach ($entry in ($InitialUser -split ",")) {
  $entry = $entry.Trim()
  if ([string]::IsNullOrWhiteSpace($entry)) {
    continue
  }

  $parts = $entry.Split(":", 2)
  if ($parts.Length -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
    throw "InitialUser must use username:password format. Invalid entry: $entry"
  }
  $scope = Ensure-UserWorkspace $parts[0]
  Ensure-FileBrowserUser -Username $parts[0] -Password $parts[1] -Scope $scope -IsAdmin $false
}

Sync-ExistingUserWorkspaces

$firewallRule = Get-NetFirewallRule -DisplayName "CZ Cloud Drive $Port" -ErrorAction SilentlyContinue
if (!$firewallRule) {
  New-NetFirewallRule -DisplayName "CZ Cloud Drive $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
}

cmd.exe /c "schtasks.exe /Query /TN $TaskName >NUL 2>NUL"
if ($LASTEXITCODE -eq 0) {
  schtasks.exe /Delete /TN $TaskName /F | Out-Null
}

$taskArgument = "-d `"$DbPath`""
$action = New-ScheduledTaskAction -Execute $ExePath -Argument $taskArgument
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -User $AdminUser -Password $AdminPassword -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$scriptPath = $PSCommandPath
$syncArgument = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -InstallDir `"$InstallDir`" -Port $Port -AdminUser `"$AdminUser`" -WebPassword `"$WebPassword`" -Locale `"$Locale`" -BrandingName `"$BrandingName`" -SharedFolderName `"$SharedFolderName`" -PrivateFolderName `"$PrivateFolderName`" -UsersRootName `"$UsersRootName`" -SharedRootName `"$SharedRootName`" -SyncOnly"
$syncAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $syncArgument
$syncStartupTrigger = New-ScheduledTaskTrigger -AtStartup
$syncRepeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $SyncTaskName -Action $syncAction -Trigger @($syncStartupTrigger, $syncRepeatTrigger) -User $AdminUser -Password $AdminPassword -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $SyncTaskName
Start-Sleep -Seconds 5

$currentListeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
if (!$currentListeners) {
  throw "File Browser is not listening on port $Port"
}

Write-Output "LISTENERS:"
$currentListeners | Format-Table -AutoSize
Write-Output "DATA_DIR=$DataDir"
Write-Output "SHARED_DIR=$SharedDir"
Write-Output "USERS_ROOT=$UsersRootDir"
Write-Output "BRANDING_DIR=$BrandingDir"
Write-Output "SYNC_TASK=$SyncTaskName"
Write-Output "SHARED_FOLDER_NAME=$SharedFolderName"
Write-Output "PRIVATE_FOLDER_NAME=$PrivateFolderName"
Write-Output "URL=http://0.0.0.0:$Port"
