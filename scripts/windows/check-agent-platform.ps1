<#
.SYNOPSIS
Collects read-only Hermes Agent Platform deployment checks on the Windows host.
#>

[CmdletBinding()]
param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 3080,
    [string]$PublicHost = "60.205.213.254",
    [int]$PublicPort = 2444,
    [string]$AgentTaskName = "CZ Hermes Agent Platform",
    [string]$FrpcTaskName = "CZ CloudService frpc",
    [string]$RuntimeDir = "C:\ProgramData\CZ-CloudService\agent-platform\runtime"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

function Write-Check {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Detail = ""
    )
    $line = "[{0}] {1}" -f $Status, $Name
    if (-not [string]::IsNullOrWhiteSpace($Detail)) {
        $line = "$line - $Detail"
    }
    Write-Host $line
}

function Test-Http {
    param(
        [string]$Name,
        [string]$Uri
    )
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -Proxy $null -TimeoutSec 10
        Write-Check $Name "OK" ("HTTP {0}, {1} bytes" -f [int]$response.StatusCode, $response.RawContentLength)
    }
    catch {
        Write-Check $Name "FAIL" $_.Exception.Message
    }
}

function Test-Task {
    param(
        [string]$Name,
        [string]$TaskName
    )
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Check $Name "OK" ("State={0}" -f $task.State)
    }
    catch {
        Write-Check $Name "FAIL" $_.Exception.Message
    }
}

function Test-DockerCommand {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) {
        Write-Check "docker CLI" "FAIL" "Get-Command docker returned no command."
        return
    }

    Write-Check "docker CLI" "OK" $docker.Source
    try {
        $version = & docker version --format '{{.Server.Version}}' 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Check "docker daemon" "OK" ("ServerVersion={0}" -f (($version | Select-Object -First 1) -as [string]))
        }
        else {
            Write-Check "docker daemon" "FAIL" (($version | Out-String).Trim())
        }
    }
    catch {
        Write-Check "docker daemon" "FAIL" $_.Exception.Message
    }
}

function Test-DockerService {
    param([string]$ServiceName)

    $output = & sc.exe query $ServiceName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $state = ($output | Select-String -Pattern "STATE" | Select-Object -First 1).ToString().Trim()
        Write-Check "docker service $ServiceName" "OK" $state
    }
    else {
        Write-Check "docker service $ServiceName" "FAIL" (($output | Out-String).Trim())
    }
}

function Test-AgentLauncherMode {
    param([string]$LauncherPath)

    if (-not (Test-Path $LauncherPath -PathType Leaf)) {
        Write-Check "agent launcher DOCKER_MANAGER_MODE" "FAIL" "start-agent-platform.cmd not found at $LauncherPath"
        return
    }

    $modeLine = Select-String -Path $LauncherPath -Pattern '^set "DOCKER_MANAGER_MODE=([^"]+)"' | Select-Object -First 1
    if (-not $modeLine) {
        Write-Check "agent launcher DOCKER_MANAGER_MODE" "FAIL" "DOCKER_MANAGER_MODE line not found in start-agent-platform.cmd"
        return
    }

    $mode = $modeLine.Matches[0].Groups[1].Value
    if ($mode -eq "real") {
        Write-Check "agent launcher DOCKER_MANAGER_MODE" "OK" "real"
    }
    else {
        Write-Check "agent launcher DOCKER_MANAGER_MODE" "WARN" $mode
    }
}

Write-Check "local web target" "INFO" "http://$HostName`:$Port/"
Test-Http "local Hermes Agent web app" "http://127.0.0.1:$Port/"

$frpcProcess = Get-Process frpc -ErrorAction SilentlyContinue
if ($frpcProcess) {
    Write-Check "frpc process" "OK" ("pid={0}" -f (($frpcProcess | Select-Object -First 1).Id))
}
else {
    Write-Check "frpc process" "FAIL" "Get-Process frpc returned no process."
}

Test-Task "agent platform scheduled task" $AgentTaskName
Test-Task "frpc scheduled task" $FrpcTaskName
Test-DockerCommand
Test-DockerService "com.docker.service"
Test-DockerService "docker"
Test-AgentLauncherMode (Join-Path $RuntimeDir "start-agent-platform.cmd")

$tcp = Test-NetConnection -ComputerName $PublicHost -Port $PublicPort -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) {
    Write-Check "public TCP $PublicHost`:$PublicPort" "OK" ("remote={0}:{1}" -f $PublicHost, $PublicPort)
}
else {
    Write-Check "public TCP $PublicHost`:$PublicPort" "FAIL" "Test-NetConnection did not connect."
}

Test-Http "public Hermes Agent web app" "http://$PublicHost`:$PublicPort/"

Write-Check "expected frpc proxy" "INFO" "hermes-agent-web-$PublicPort -> 127.0.0.1:$Port"
