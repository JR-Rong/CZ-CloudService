<#
.SYNOPSIS
Configures a Windows frpc client for exposing local OpenSSH, the Hermes Agent web app, the AI LLM API, and the AI chat web app through an ECS frps server.

.DESCRIPTION
This script downloads frpc if needed, verifies the local SSH service, writes frpc.toml,
starts frpc, and can create either a current-user startup shortcut or a Windows
Scheduled Task. It intentionally requires the FRP auth token at runtime so secrets
are not committed to the repository.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\setup-frpc.ps1 -AuthToken "<token>" -CreateStartupShortcut

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\setup-frpc.ps1 -AuthToken "<token>" -RegisterScheduledTask -ScheduledTaskTrigger AtLogon
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

    [string]$AgentWebProxyName = "",
    [string]$AgentWebLocalIP = "127.0.0.1",
    [int]$AgentWebLocalPort = 3080,
    [int]$AgentWebRemotePort = 2444,
    [switch]$DisableAgentWebProxy,
    [switch]$CheckAgentWebPort,

    [string]$LlmProxyName = "",
    [string]$LlmLocalIP = "192.168.100.12",
    [int]$LlmLocalPort = 8000,
    [int]$LlmRemotePort = 9000,
    [switch]$DisableLlmProxy,
    [switch]$CheckLlmPort,

    [string]$AiChatWebProxyName = "",
    [string]$AiChatWebLocalIP = "192.168.100.12",
    [int]$AiChatWebLocalPort = 9999,
    [int]$AiChatWebRemotePort = 9999,
    [switch]$DisableAiChatWebProxy,
    [switch]$CheckAiChatWebPort,

    [string]$InstallDir = "$env:USERPROFILE\todesk-ssh",
    [string]$FrpVersion = "0.69.1",
    [string]$FrpZipUrl = "",
    [string]$FrpZipSha256 = "",

    [switch]$SkipDownload,
    [switch]$SkipLocalPortCheck,
    [switch]$NoStart,
    [switch]$CreateStartupShortcut,
    [switch]$RegisterScheduledTask,
    [switch]$RestartExistingDetached,
    [int]$RestartDelaySeconds = 5,
    [ValidateSet("AtLogon", "AtStartup")]
    [string]$ScheduledTaskTrigger = "AtLogon",
    [string]$ScheduledTaskName = "CZ CloudService frpc",
    [switch]$ForceScheduledTask,
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

function Test-IsAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-FrpcLauncher {
    param(
        [string]$TargetInstallDir,
        [string]$TargetFrpcExe,
        [string]$TargetConfigPath
    )

    $launcherPath = Join-Path $TargetInstallDir "start-frpc.cmd"
    $launcher = @"
@echo off
cd /d "$TargetInstallDir"
"$TargetFrpcExe" -c "$TargetConfigPath"
"@
    $launcher | Set-Content -Encoding ascii $launcherPath
    return $launcherPath
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

function Convert-ToPowerShellSingleQuotedLiteral {
    param([string]$Value)

    if ($null -eq $Value) {
        return ""
    }

    return $Value.Replace("'", "''")
}

function Start-DetachedFrpcRestart {
    param(
        [string]$TargetInstallDir,
        [string]$TargetFrpcExe,
        [string]$TargetConfigPath,
        [int]$DelaySeconds
    )

    $restartPath = Join-Path $TargetInstallDir "restart-frpc-delayed.ps1"
    $restartLog = Join-Path $TargetInstallDir "restart-frpc-delayed.log"
    $restartScript = @'
$ErrorActionPreference = "Stop"

function Write-RestartLog {
    param([string]$Message)
    "$(Get-Date -Format o) $Message" | Add-Content -Encoding ascii -LiteralPath '__RESTART_LOG__'
}

function Stop-ExistingFrpc {
    param([string]$TargetInstallDir)

    $normalized = [System.IO.Path]::GetFullPath($TargetInstallDir).TrimEnd('\')
    foreach ($process in (Get-Process frpc -ErrorAction SilentlyContinue)) {
        if ($process.Path -and $process.Path.StartsWith($normalized, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-RestartLog "Stopping frpc process $($process.Id)"
            Stop-Process -Id $process.Id -Force
        }
    }
}

$TargetInstallDir = '__TARGET_INSTALL_DIR__'
$TargetFrpcExe = '__TARGET_FRPC_EXE__'
$TargetConfigPath = '__TARGET_CONFIG_PATH__'

Start-Sleep -Seconds $DelaySeconds
try {
    Stop-ExistingFrpc -TargetInstallDir $TargetInstallDir
    Start-Sleep -Seconds 2
    $process = Start-Process -FilePath $TargetFrpcExe -ArgumentList "-c `"$TargetConfigPath`"" -WorkingDirectory $TargetInstallDir -WindowStyle Minimized -PassThru
    Start-Sleep -Seconds 2
    if ($process.HasExited) {
        Write-RestartLog "frpc exited quickly after delayed restart"
        exit 1
    }
    Write-RestartLog "frpc restarted with PID $($process.Id)"
}
catch {
    Write-RestartLog "restart failed: $($_.Exception.Message)"
    exit 1
}
finally {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
'@

    $restartScript = $restartScript.Replace("__RESTART_LOG__", (Convert-ToPowerShellSingleQuotedLiteral $restartLog))
    $restartScript = $restartScript.Replace("__TARGET_INSTALL_DIR__", (Convert-ToPowerShellSingleQuotedLiteral $TargetInstallDir))
    $restartScript = $restartScript.Replace("__TARGET_FRPC_EXE__", (Convert-ToPowerShellSingleQuotedLiteral $TargetFrpcExe))
    $restartScript = $restartScript.Replace("__TARGET_CONFIG_PATH__", (Convert-ToPowerShellSingleQuotedLiteral $TargetConfigPath))
    $restartScript = $restartScript.Replace('$DelaySeconds', [string]$DelaySeconds)

    Set-Content -LiteralPath $restartPath -Encoding ascii -Value $restartScript
    Start-Process -FilePath 'powershell' `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $restartPath) `
        -WindowStyle Hidden | Out-Null
    Write-Step "Scheduled delayed detached frpc restart in $DelaySeconds second(s). Log: $restartLog"
}

function Register-FrpcTask {
    param(
        [string]$TaskName,
        [string]$TriggerKind,
        [string]$LauncherPath,
        [switch]$Force
    )

    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw "Scheduled Task cmdlets are not available on this Windows installation."
    }

    if ($TriggerKind -eq "AtStartup" -and -not (Test-IsAdministrator)) {
        throw "-ScheduledTaskTrigger AtStartup requires elevated PowerShell because it registers a SYSTEM startup task."
    }

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) {
        throw "Scheduled Task '$TaskName' already exists. Rerun with -ForceScheduledTask to replace it."
    }

    $action = New-ScheduledTaskAction `
        -Execute "$env:WINDIR\System32\cmd.exe" `
        -Argument "/c `"$LauncherPath`""

    if ($TriggerKind -eq "AtStartup") {
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    }
    else {
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    }

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Start CZ CloudService frpc using $LauncherPath"

    $registerParams = @{
        TaskName = $TaskName
        InputObject = $task
    }
    if ($Force) {
        $registerParams["Force"] = $true
    }

    Register-ScheduledTask @registerParams | Out-Null
}

if ([string]::IsNullOrWhiteSpace($ProxyName)) {
    $ProxyName = "windows-ssh-$RemotePort"
}
if ([string]::IsNullOrWhiteSpace($AgentWebProxyName)) {
    $AgentWebProxyName = "hermes-agent-web-$AgentWebRemotePort"
}
if ([string]::IsNullOrWhiteSpace($LlmProxyName)) {
    $LlmProxyName = "ai-llm-qwen36-$LlmRemotePort"
}
if ([string]::IsNullOrWhiteSpace($AiChatWebProxyName)) {
    $AiChatWebProxyName = "ai-chat-web-$AiChatWebRemotePort"
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

if ((-not $DisableAgentWebProxy) -and $CheckAgentWebPort) {
    Write-Step "Checking Hermes Agent web app at $AgentWebLocalIP`:$AgentWebLocalPort"
    if (-not (Test-TcpPort -HostName $AgentWebLocalIP -Port $AgentWebLocalPort)) {
        throw "Hermes Agent web app is not reachable at $AgentWebLocalIP`:$AgentWebLocalPort. Start the app first, or omit -CheckAgentWebPort."
    }
}

if ((-not $DisableLlmProxy) -and $CheckLlmPort) {
    Write-Step "Checking AI LLM service at $LlmLocalIP`:$LlmLocalPort"
    if (-not (Test-TcpPort -HostName $LlmLocalIP -Port $LlmLocalPort)) {
        throw "AI LLM service is not reachable at $LlmLocalIP`:$LlmLocalPort. Start ai-llm.service first, or omit -CheckLlmPort."
    }
}

if ((-not $DisableAiChatWebProxy) -and $CheckAiChatWebPort) {
    Write-Step "Checking AI chat web app at $AiChatWebLocalIP`:$AiChatWebLocalPort"
    if (-not (Test-TcpPort -HostName $AiChatWebLocalIP -Port $AiChatWebLocalPort)) {
        throw "AI chat web app is not reachable at $AiChatWebLocalIP`:$AiChatWebLocalPort. Start ai-chat-web.service first, or omit -CheckAiChatWebPort."
    }
}

if ($RestartExistingDetached -and $NoStart) {
    throw "-RestartExistingDetached cannot be combined with -NoStart."
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

if (-not $DisableAgentWebProxy) {
    $config += @"

[[proxies]]
name = $(Convert-ToTomlString $AgentWebProxyName)
type = "tcp"
localIP = $(Convert-ToTomlString $AgentWebLocalIP)
localPort = $AgentWebLocalPort
remotePort = $AgentWebRemotePort
"@
}

if (-not $DisableLlmProxy) {
    $config += @"

[[proxies]]
name = $(Convert-ToTomlString $LlmProxyName)
type = "tcp"
localIP = $(Convert-ToTomlString $LlmLocalIP)
localPort = $LlmLocalPort
remotePort = $LlmRemotePort
"@
}

if (-not $DisableAiChatWebProxy) {
    $config += @"

[[proxies]]
name = $(Convert-ToTomlString $AiChatWebProxyName)
type = "tcp"
localIP = $(Convert-ToTomlString $AiChatWebLocalIP)
localPort = $AiChatWebLocalPort
remotePort = $AiChatWebRemotePort
"@
}

$config | Set-Content -Encoding ascii $configPath

if ($CreateStartupShortcut -or $RegisterScheduledTask) {
    $launcherPath = New-FrpcLauncher -TargetInstallDir $InstallDir -TargetFrpcExe $frpcExe -TargetConfigPath $configPath
}

if ($CreateStartupShortcut) {
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

if ($RegisterScheduledTask) {
    Register-FrpcTask -TaskName $ScheduledTaskName -TriggerKind $ScheduledTaskTrigger -LauncherPath $launcherPath -Force:$ForceScheduledTask
    Write-Step "Registered Scheduled Task '$ScheduledTaskName' with trigger $ScheduledTaskTrigger"
}

if ($RestartExistingDetached) {
    Start-DetachedFrpcRestart -TargetInstallDir $InstallDir -TargetFrpcExe $frpcExe -TargetConfigPath $configPath -DelaySeconds $RestartDelaySeconds
}
else {
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
}

Write-Host ""
Write-Host "Next checks:"
Write-Host "  1. Windows local SSH: ssh -p $LocalPort admin@$LocalIP hostname"
Write-Host "  2. ECS listener:       ssh root@$ServerAddr 'ss -tlnp | grep $RemotePort'"
Write-Host "  3. Public SSH:         ssh -p $RemotePort admin@$ServerAddr hostname"
if (-not $DisableAgentWebProxy) {
    Write-Host "  4. Local web app:      Invoke-WebRequest http://$AgentWebLocalIP`:$AgentWebLocalPort/ -UseBasicParsing"
    Write-Host "  5. Public web app:     curl -i http://$ServerAddr`:$AgentWebRemotePort/"
}
if (-not $DisableLlmProxy) {
    Write-Host "  6. Local LLM health:   Invoke-WebRequest http://$LlmLocalIP`:$LlmLocalPort/health -UseBasicParsing"
    Write-Host "  7. Public LLM health:  curl -i http://$ServerAddr`:$LlmRemotePort/health"
}
if (-not $DisableAiChatWebProxy) {
    Write-Host "  8. Local AI web:       Invoke-WebRequest http://$AiChatWebLocalIP`:$AiChatWebLocalPort/health -UseBasicParsing"
    Write-Host "  9. Public AI web:      curl -i http://$ServerAddr`:$AiChatWebRemotePort/"
}
if ($RegisterScheduledTask) {
    Write-Host "  10. Scheduled Task:    Get-ScheduledTask -TaskName `"$ScheduledTaskName`""
}
