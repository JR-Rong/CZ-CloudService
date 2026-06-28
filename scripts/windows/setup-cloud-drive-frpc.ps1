param(
  [string]$FrpDir = "C:\Users\chuan\todesk-ssh",
  [string]$Port = "2233",
  [string]$AdminUser = "admin",
  [Parameter(Mandatory = $true)]
  [string]$AdminPassword
)

$ErrorActionPreference = "Stop"

$SourceConfig = Join-Path $FrpDir "frpc.toml"
$DriveConfig = Join-Path $FrpDir "frpc-cloud-drive.toml"
$DriveLog = Join-Path $FrpDir "frpc-cloud-drive.log"
$FrpcExe = Join-Path $FrpDir "frp_0.69.1_windows_amd64\frpc.exe"
$TaskName = "CZCloudDriveFrpc"

if (!(Test-Path $SourceConfig)) {
  throw "Source frpc config not found: $SourceConfig"
}
if (!(Test-Path $FrpcExe)) {
  throw "frpc.exe not found: $FrpcExe"
}

$raw = Get-Content $SourceConfig -Raw
$serverAddr = ([regex]::Match($raw, 'serverAddr\s*=\s*"([^"]+)"')).Groups[1].Value
$serverPort = ([regex]::Match($raw, 'serverPort\s*=\s*(\d+)')).Groups[1].Value
$authMethod = ([regex]::Match($raw, 'auth\.method\s*=\s*"([^"]+)"')).Groups[1].Value
$authToken = ([regex]::Match($raw, 'auth\.token\s*=\s*"([^"]+)"')).Groups[1].Value

if (!$serverAddr -or !$serverPort -or !$authMethod -or !$authToken) {
  throw "Failed to parse server/auth fields from $SourceConfig"
}

$DriveLogToml = $DriveLog -replace '\\', '\\'
$toml = @"
log.to = "$DriveLogToml"
log.level = "debug"
log.maxDays = 3

serverAddr = "$serverAddr"
serverPort = $serverPort

auth.method = "$authMethod"
auth.token = "$authToken"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.enable = true
transport.tcpMux = false

[[proxies]]
name = "ai-station-cloud-drive-$Port"
type = "tcp"
localIP = "127.0.0.1"
localPort = $Port
remotePort = $Port
"@

Set-Content -Path $DriveConfig -Value $toml -Encoding ASCII

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "frpc.exe" -and $_.CommandLine -like "*frpc-cloud-drive.toml*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$taskArgument = "-c `"$DriveConfig`""
$action = New-ScheduledTaskAction -Execute $FrpcExe -Argument $taskArgument
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -User $AdminUser -Password $AdminPassword -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

Write-Output "CONFIG=$DriveConfig"
Get-Content $DriveConfig | ForEach-Object {
  if ($_ -match "(?i)(token|password|secret)") {
    $_ -replace "=.*", "= <redacted>"
  } else {
    $_
  }
}

Write-Output "TASK:"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize

Write-Output "PROCESS:"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "frpc.exe" -and $_.CommandLine -like "*frpc-cloud-drive.toml*" } |
  Select-Object ProcessId, Name, CommandLine |
  Format-List

Write-Output "LOG_TAIL:"
if (Test-Path $DriveLog) {
  Get-Content $DriveLog -Tail 80
}
