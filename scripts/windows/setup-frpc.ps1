<#
.SYNOPSIS
Configures a Windows frpc client for exposing local OpenSSH through an ECS frps server.

.DESCRIPTION
This script downloads frpc if needed, verifies the local SSH service, writes frpc.toml,
starts frpc, and can create a current-user startup shortcut. It intentionally requires
the FRP auth token at runtime so secrets are not committed to the repository.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\setup-frpc.ps1 -AuthToken "<token>" -CreateStartupShortcut
#>

[CmdletBinding()]
param(
    [string]$ServerAddr = "60.205.213.254",
    [int]$ServerPort = 7000,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AuthToken,

    [string]$ProxyName = "",
    [string]$LocalIP = "127.0.0.1",
    [int]$LocalPort = 22222,
    [int]$RemotePort = 2222,

    [string]$InstallDir = "$env:USERPROFILE\todesk-ssh",
    [string]$FrpVersion = "0.69.1",
    [string]$FrpZipUrl = "",
    [string]$FrpZipSha256 = "",

    [switch]$SkipDownload,
    [switch]$SkipLocalPortCheck,
    [switch]$NoStart,
    [switch]$CreateStartupShortcut,
    [bool]$StopExisting = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[setup-frpc] $Message"
}

function Convert-ToTomlString {
    param([string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
}

function Test-TcpPort {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutMs = 3000
    )

    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            $client.Close()
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) {
            $client.Dispose()
        }
    }
}

function Stop-ExistingFrpc {
    param([string]$TargetInstallDir)

    $normalized = [System.IO.Path]::GetFullPath($TargetInstallDir).TrimEnd('\')
    foreach ($process in (Get-Process frpc -ErrorAction SilentlyContinue)) {
        try {
            if ($process.Path -and $process.Path.StartsWith($normalized, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Step "Stopping existing frpc process $($process.Id)"
                Stop-Process -Id $process.Id -Force
            }
        }
        catch {
            Write-Warning "Could not inspect or stop frpc process $($process.Id): $($_.Exception.Message)"
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ProxyName)) {
    $ProxyName = "windows-ssh-$RemotePort"
}

$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
if (-not [System.IO.Path]::IsPathRooted($InstallDir)) {
    $InstallDir = Join-Path (Get-Location) $InstallDir
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

$archivePath = Join-Path $InstallDir "frp_$($FrpVersion)_windows_amd64.zip"
$extractRoot = Join-Path $InstallDir "_frp_extract"
$frpFolder = Join-Path $InstallDir "frp_$($FrpVersion)_windows_amd64"
$frpcExe = Join-Path $frpFolder "frpc.exe"
$configPath = Join-Path $InstallDir "frpc.toml"
$logPath = (Join-Path $InstallDir "frpc.log").Replace('\', '/')

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

if (-not $SkipLocalPortCheck) {
    Write-Step "Checking local SSH service at $LocalIP`:$LocalPort"
    if (-not (Test-TcpPort -HostName $LocalIP -Port $LocalPort)) {
        throw "Local SSH service is not reachable at $LocalIP`:$LocalPort. Start Windows OpenSSH first, or rerun with -SkipLocalPortCheck."
    }
}

if (-not (Test-Path $frpcExe)) {
    if ($SkipDownload) {
        throw "frpc.exe not found at $frpcExe and -SkipDownload was specified."
    }

    if ([string]::IsNullOrWhiteSpace($FrpZipUrl)) {
        $FrpZipUrl = "https://github.com/fatedier/frp/releases/download/v$FrpVersion/frp_$($FrpVersion)_windows_amd64.zip"
    }

    Write-Step "Downloading frp from $FrpZipUrl"
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -fL --retry 5 --connect-timeout 20 -o $archivePath $FrpZipUrl
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe failed with exit code $LASTEXITCODE"
        }
    }
    else {
        Invoke-WebRequest -Uri $FrpZipUrl -OutFile $archivePath
    }

    if (-not [string]::IsNullOrWhiteSpace($FrpZipSha256)) {
        $actualHash = (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $FrpZipSha256.ToLowerInvariant()) {
            throw "FRP zip SHA256 mismatch. Expected $FrpZipSha256, got $actualHash."
        }
    }

    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $archivePath -DestinationPath $extractRoot -Force

    $extractedFrpc = Get-ChildItem $extractRoot -Filter frpc.exe -Recurse | Select-Object -First 1
    if (-not $extractedFrpc) {
        throw "Downloaded archive did not contain frpc.exe."
    }

    $sourceDir = Split-Path $extractedFrpc.FullName -Parent
    Remove-Item $frpFolder -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $sourceDir $frpFolder -Recurse -Force
    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step "Writing $configPath"
$config = @"
serverAddr = $(Convert-ToTomlString $ServerAddr)
serverPort = $ServerPort

auth.method = "token"
auth.token = $(Convert-ToTomlString $AuthToken)
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.enable = true
transport.tcpMux = false

log.to = $(Convert-ToTomlString $logPath)
log.level = "debug"
log.maxDays = 3

[[proxies]]
name = $(Convert-ToTomlString $ProxyName)
type = "tcp"
localIP = $(Convert-ToTomlString $LocalIP)
localPort = $LocalPort
remotePort = $RemotePort
"@

$config | Set-Content -Encoding ascii $configPath

if ($CreateStartupShortcut) {
    $launcherPath = Join-Path $InstallDir "start-frpc.cmd"
    $launcher = @"
@echo off
cd /d "$InstallDir"
"$frpcExe" -c "$configPath"
"@
    $launcher | Set-Content -Encoding ascii $launcherPath

    $startupDir = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startupDir "CZ CloudService frpc.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Start CZ CloudService frpc"
    $shortcut.Save()
    Write-Step "Created startup shortcut $shortcutPath"
}

if ($StopExisting) {
    Stop-ExistingFrpc -TargetInstallDir $InstallDir
}

if (-not $NoStart) {
    Write-Step "Starting frpc"
    $process = Start-Process -FilePath $frpcExe -ArgumentList "-c `"$configPath`"" -WorkingDirectory $InstallDir -WindowStyle Minimized -PassThru
    Start-Sleep -Seconds 2

    if ($process.HasExited) {
        Write-Warning "frpc exited quickly. Check $logPath for details."
    }
    else {
        Write-Step "frpc started with PID $($process.Id)"
    }
}

Write-Host ""
Write-Host "Next checks:"
Write-Host "  1. Windows local SSH: ssh -p $LocalPort admin@$LocalIP hostname"
Write-Host "  2. ECS listener:       ssh root@$ServerAddr 'ss -tlnp | grep $RemotePort'"
Write-Host "  3. Public SSH:         ssh -p $RemotePort admin@$ServerAddr hostname"
