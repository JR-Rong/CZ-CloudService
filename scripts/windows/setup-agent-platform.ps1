<#
.SYNOPSIS
Prepares and starts the Hermes Agent management web app on the Windows host.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 3080,
    [ValidateSet("dry-run", "real")]
    [string]$DockerManagerMode = "real",
    [string]$HermesImage = "hermes:latest",
    [string]$LocalLlmBaseUrl = "http://192.168.100.12:8000/v1",
    [string]$LocalLlmModel = "qwen3.6-35b-a3b",
    [string]$LocalLlmApiKeyEnv = "AI_API_KEY",
    [string]$BootstrapAdminUsername = "admin",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BootstrapAdminPassword,
    [string]$NodeExe = "",
    [switch]$RegisterScheduledTask,
    [ValidateSet("AtLogon", "AtStartup")]
    [string]$ScheduledTaskTrigger = "AtLogon",
    [switch]$ForceScheduledTask,
    [string]$ScheduledTaskName = "CZ Hermes Agent Platform",
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[setup-agent-platform] $Message"
}

function Test-IsAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

$appDir = Join-Path $RepoRoot "apps\ui"
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
}
else {
    $nodeExe = [Environment]::ExpandEnvironmentVariables($NodeExe)
    if (-not [System.IO.Path]::IsPathRooted($nodeExe)) {
        $nodeExe = (Resolve-Path $nodeExe).Path
    }
    if (-not (Test-Path $nodeExe -PathType Leaf)) {
        throw "Node.js executable not found at $nodeExe."
    }
}
$runtimeDir = "C:\ProgramData\CZ-CloudService\agent-platform\runtime"
$dataFile = "C:\ProgramData\CZ-CloudService\agent-platform\state.json"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$localLlmApiKey = [Environment]::GetEnvironmentVariable($LocalLlmApiKeyEnv)
if ($DockerManagerMode -eq "real" -and [string]::IsNullOrWhiteSpace($localLlmApiKey)) {
    throw "Missing runtime LLM API key. Set $LocalLlmApiKeyEnv before running this script."
}

$env:HOST = $HostName
$env:PORT = [string]$Port
$env:DOCKER_MANAGER_MODE = $DockerManagerMode
$env:HERMES_IMAGE = $HermesImage
$env:LOCAL_LLM_BASE_URL = $LocalLlmBaseUrl
$env:LOCAL_LLM_MODEL = $LocalLlmModel
$env:LOCAL_LLM_API_KEY_ENV = $LocalLlmApiKeyEnv
if (-not [string]::IsNullOrEmpty($localLlmApiKey)) {
    Set-Item -Path "Env:$LocalLlmApiKeyEnv" -Value $localLlmApiKey
}
$env:BOOTSTRAP_ADMIN_USERNAME = $BootstrapAdminUsername
$env:BOOTSTRAP_ADMIN_PASSWORD = $BootstrapAdminPassword
$env:AGENT_PLATFORM_RUNTIME_DIR = $runtimeDir
$env:AGENT_PLATFORM_DATA = $dataFile

if ($RegisterScheduledTask) {
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw "Scheduled Task cmdlets are not available on this Windows installation."
    }
    if ($ScheduledTaskTrigger -eq "AtStartup" -and -not (Test-IsAdministrator)) {
        throw "-ScheduledTaskTrigger AtStartup requires elevated PowerShell because it registers a SYSTEM startup task."
    }

    $launcherPath = Join-Path $runtimeDir "start-agent-platform.cmd"
    $launcherApiKeyLine = ""
    if (-not [string]::IsNullOrEmpty($localLlmApiKey)) {
        $launcherApiKeyLine = "set `"$LocalLlmApiKeyEnv=$localLlmApiKey`""
    }
@"
@echo off
set "HOST=$HostName"
set "PORT=$Port"
set "DOCKER_MANAGER_MODE=$DockerManagerMode"
set "HERMES_IMAGE=$HermesImage"
set "LOCAL_LLM_BASE_URL=$LocalLlmBaseUrl"
set "LOCAL_LLM_MODEL=$LocalLlmModel"
set "LOCAL_LLM_API_KEY_ENV=$LocalLlmApiKeyEnv"
$launcherApiKeyLine
set "BOOTSTRAP_ADMIN_USERNAME=$BootstrapAdminUsername"
set "BOOTSTRAP_ADMIN_PASSWORD=$BootstrapAdminPassword"
set "AGENT_PLATFORM_RUNTIME_DIR=$runtimeDir"
set "AGENT_PLATFORM_DATA=$dataFile"
cd /d "$appDir"
"$nodeExe" src\server.js
"@ | Set-Content -Encoding ascii $launcherPath

    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument "/c `"$launcherPath`""
    if ($ScheduledTaskTrigger -eq "AtStartup") {
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    }
    else {
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    }
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Start Hermes Agent management platform"
    $params = @{ TaskName = $ScheduledTaskName; InputObject = $task }
    if ($ForceScheduledTask) {
        $params["Force"] = $true
    }
    Register-ScheduledTask @params | Out-Null
    Write-Step "Registered Scheduled Task '$ScheduledTaskName' with trigger $ScheduledTaskTrigger"
}

if (-not $NoStart) {
    Write-Step "Starting Hermes Agent web app on http://$HostName`:$Port/"
    Push-Location $appDir
    try {
        & $nodeExe src\server.js
    }
    finally {
        Pop-Location
    }
}
