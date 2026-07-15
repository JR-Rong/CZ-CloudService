[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("Preflight", "Plan", "SelfTest", "PrepareBundle", "Apply", "Verify", "Confirm", "Rollback", "PeerAdd", "PeerRevoke", "Evidence")]
    [string]$Action = "Preflight",

    [string]$Config = "",
    [string]$PeerName = "",
    [ValidateSet("Admin", "Employee")]
    [string]$Role = "Admin",
    [switch]$ConfirmConsole,
    [switch]$ConfirmExternal,
    [string]$BackupId = "",
    [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptVersion = 3
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = Split-Path -Parent $ScriptPath
$IsWindowsPlatform = $env:OS -eq "Windows_NT"
$RuntimeRoot = if ($env:CZ_SAFETY_WINDOWS_ROOT) { $env:CZ_SAFETY_WINDOWS_ROOT } elseif ($IsWindowsPlatform) { "$env:ProgramData\CZ-Safety" } else { Join-Path $ScriptDir ".work/windows-runtime" }
$FirewallGroup = "CZ-Safety"

function Write-Info {
    param([string]$Message)
    Write-Host "[cz-safety] $Message"
}

function Throw-Config {
    param([string]$Message)
    throw "Configuration error: $Message"
}

function Test-Administrator {
    if (-not $IsWindowsPlatform) { return $false }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-SiteConfig {
    param([string]$Path)
    if (-not $Path) { Throw-Config "-Config is required for $Action" }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Throw-Config "file not found: $Path" }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        Throw-Config "invalid JSON in ${Path}: $($_.Exception.Message)"
    }
}

function Require-Property {
    param([object]$Object, [string]$Name, [string]$Context)
    if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
        Throw-Config "$Context.$Name is required"
    }
    $value = $Object.$Name
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) {
        Throw-Config "$Context.$Name cannot be empty"
    }
    return $value
}

function ConvertTo-IPv4UInt32 {
    param([string]$Address)
    $parsed = [System.Net.IPAddress]::Parse($Address)
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        Throw-Config "$Address is not IPv4"
    }
    $bytes = $parsed.GetAddressBytes()
    return [uint32](
        ([uint32]$bytes[0] -shl 24) -bor
        ([uint32]$bytes[1] -shl 16) -bor
        ([uint32]$bytes[2] -shl 8) -bor
        [uint32]$bytes[3]
    )
}

function ConvertFrom-IPv4UInt32 {
    param([uint32]$Value)
    return "{0}.{1}.{2}.{3}" -f (($Value -shr 24) -band 255), (($Value -shr 16) -band 255), (($Value -shr 8) -band 255), ($Value -band 255)
}

function Get-CidrInfo {
    param([string]$Cidr)
    if ($Cidr -notmatch '^([^/]+)/([0-9]{1,2})$') { Throw-Config "invalid CIDR: $Cidr" }
    $address = $Matches[1]
    $prefix = [int]$Matches[2]
    if ($prefix -lt 0 -or $prefix -gt 32) { Throw-Config "invalid CIDR prefix: $Cidr" }
    $ip = ConvertTo-IPv4UInt32 $address
    $allBits = [uint64]4294967295
    $mask = if ($prefix -eq 0) { [uint32]0 } else { [uint32](($allBits -shl (32 - $prefix)) -band $allBits) }
    $network = [uint32]($ip -band $mask)
    $hostMask = [uint32]($allBits -bxor [uint64]$mask)
    $broadcast = [uint32]($network -bor $hostMask)
    return [pscustomobject]@{
        Address = $address
        Prefix = $prefix
        AddressValue = $ip
        NetworkValue = $network
        BroadcastValue = $broadcast
        Network = ConvertFrom-IPv4UInt32 $network
        Broadcast = ConvertFrom-IPv4UInt32 $broadcast
    }
}

function Test-NetworkOverlap {
    param([object]$Left, [object]$Right)
    return $Left.NetworkValue -le $Right.BroadcastValue -and $Right.NetworkValue -le $Left.BroadcastValue
}

function Assert-SafeToken {
    param([string]$Value, [string]$Name)
    if ($Value -notmatch '^[a-zA-Z0-9_. :/\\-]+$') { Throw-Config "$Name contains unsupported characters" }
}

function Validate-SiteConfig {
    param([object]$Site)
    if ([int](Require-Property $Site "schemaVersion" "root") -ne 1) { Throw-Config "schemaVersion must be 1" }
    $topology = Require-Property $Site "topology" "root"
    if ($topology -ne "windows-bastion") { Throw-Config "topology must be windows-bastion" }

    $public = Require-Property $Site "public" "root"
    $vpn = Require-Property $Site "vpn" "root"
    $server = Require-Property $Site "server" "root"
    $bmc = Require-Property $Site "bmc" "root"
    $wireguard = Require-Property $Site "wireguard" "root"
    [void](Require-Property $Site "packageMode" "root")
    [void](Require-Property $Site "rollbackMinutes" "root")

    foreach ($entry in @(
        @($public, "interfaceAlias", "public"),
        @($public, "cidr", "public"),
        @($public, "gateway", "public"),
        @($vpn, "interfaceName", "vpn"),
        @($vpn, "address", "vpn"),
        @($vpn, "adminCidr", "vpn"),
        @($vpn, "employeeCidr", "vpn"),
        @($server, "lanInterfaceAlias", "server"),
        @($server, "gatewayCidr", "server"),
        @($server, "address", "server"),
        @($server, "linuxInterface", "server"),
        @($server, "bootstrapUser", "server"),
        @($server, "bootstrapKeyPath", "server"),
        @($server, "knownHostsPath", "server"),
        @($bmc, "mode", "bmc"),
        @($bmc, "address", "bmc"),
        @($bmc, "webScheme", "bmc"),
        @($wireguard, "wireguardExe", "wireguard"),
        @($wireguard, "wgExe", "wireguard")
    )) {
        [void](Require-Property $entry[0] $entry[1] $entry[2])
    }

    foreach ($token in @(
        @([string]$public.interfaceAlias, "public.interfaceAlias"),
        @([string]$vpn.interfaceName, "vpn.interfaceName"),
        @([string]$server.lanInterfaceAlias, "server.lanInterfaceAlias"),
        @([string]$server.linuxInterface, "server.linuxInterface"),
        @([string]$server.bootstrapUser, "server.bootstrapUser")
    )) { Assert-SafeToken $token[0] $token[1] }

    $wan = Get-CidrInfo ([string]$public.cidr)
    if ($wan.Prefix -ne 30) { Throw-Config "public.cidr must be /30" }
    $gateway = ConvertTo-IPv4UInt32 ([string]$public.gateway)
    if ($gateway -ne ($wan.NetworkValue + 1)) { Throw-Config "public.gateway must be the first usable address" }
    if ($wan.AddressValue -ne ($wan.NetworkValue + 2)) { Throw-Config "public.cidr must use the second usable address" }

    $vpnAddress = Get-CidrInfo ([string]$vpn.address)
    $admin = Get-CidrInfo ([string]$vpn.adminCidr)
    $employee = Get-CidrInfo ([string]$vpn.employeeCidr)
    $serverGateway = Get-CidrInfo ([string]$server.gatewayCidr)
    $serverAddress = ConvertTo-IPv4UInt32 ([string]$server.address)
    if ($vpnAddress.AddressValue -lt $admin.NetworkValue -or $vpnAddress.AddressValue -gt $admin.BroadcastValue) {
        Throw-Config "vpn.address must fall inside vpn.adminCidr"
    }
    if (Test-NetworkOverlap $admin $employee) { Throw-Config "admin and employee VPN ranges overlap" }
    if ($admin.NetworkValue -lt $vpnAddress.NetworkValue -or $admin.BroadcastValue -gt $vpnAddress.BroadcastValue -or
        $employee.NetworkValue -lt $vpnAddress.NetworkValue -or $employee.BroadcastValue -gt $vpnAddress.BroadcastValue) {
        Throw-Config "admin and employee VPN ranges must be inside the VPN network"
    }
    if ((Test-NetworkOverlap $wan $vpnAddress) -or (Test-NetworkOverlap $wan $serverGateway) -or (Test-NetworkOverlap $vpnAddress $serverGateway)) {
        Throw-Config "public, VPN, and server networks must not overlap"
    }
    if ($serverAddress -lt $serverGateway.NetworkValue -or $serverAddress -gt $serverGateway.BroadcastValue) {
        Throw-Config "server.address is not in server.gatewayCidr"
    }
    if ([string]$bmc.address -ne "192.168.100.10") { Throw-Config "bmc.address must remain 192.168.100.10" }
    if ([string]$bmc.mode -notin @("disabled", "routed", "local-browser", "flat-bmc")) {
        Throw-Config "bmc.mode must be disabled, routed, local-browser, or flat-bmc"
    }
    if ([string]$bmc.webScheme -notin @("https", "http")) { Throw-Config "bmc.webScheme must be https or http" }
    if ([string]$bmc.mode -in @("routed", "local-browser", "flat-bmc")) {
        [void](Require-Property $bmc "gatewayCidr" "bmc")
        if ([string]$bmc.mode -ne "flat-bmc") { [void](Require-Property $bmc "interfaceAlias" "bmc") }
        $bmcGateway = Get-CidrInfo ([string]$bmc.gatewayCidr)
        if ((ConvertTo-IPv4UInt32 "192.168.100.10") -lt $bmcGateway.NetworkValue -or (ConvertTo-IPv4UInt32 "192.168.100.10") -gt $bmcGateway.BroadcastValue) {
            Throw-Config "BMC address is outside bmc.gatewayCidr"
        }
        if ([string]$bmc.mode -ne "flat-bmc" -and [string]$bmc.interfaceAlias -eq [string]$public.interfaceAlias) { Throw-Config "WAN and BMC interfaces must be different" }
        if ((Test-NetworkOverlap $bmcGateway $wan) -or (Test-NetworkOverlap $bmcGateway $vpnAddress) -or (Test-NetworkOverlap $bmcGateway $serverGateway)) {
            Throw-Config "BMC network overlaps public, VPN, or server network"
        }
    }
    if ([int]$public.wireguardPort -lt 1 -or [int]$public.wireguardPort -gt 65535) { Throw-Config "wireguardPort is invalid" }
    if ([int]$server.sshPort -lt 1 -or [int]$server.sshPort -gt 65535) { Throw-Config "server.sshPort is invalid" }
    if ([int]$server.httpsPort -lt 1 -or [int]$server.httpsPort -gt 65535) { Throw-Config "server.httpsPort is invalid" }
    if ([string]$Site.packageMode -notin @("skip", "online")) { Throw-Config "packageMode must be skip or online" }
    if ([int]$Site.rollbackMinutes -lt 5 -or [int]$Site.rollbackMinutes -gt 60) { Throw-Config "rollbackMinutes must be between 5 and 60" }
    return $true
}

function Test-DocumentationWan {
    param([object]$Site)
    $ip = ConvertTo-IPv4UInt32 ((Get-CidrInfo ([string]$Site.public.cidr)).Address)
    foreach ($network in @("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")) {
        $block = Get-CidrInfo $network
        if ($ip -ge $block.NetworkValue -and $ip -le $block.BroadcastValue) { return $true }
    }
    return $false
}

function Get-UbuntuHardeningPayload {
    param([object]$Site)
    $admin = [string]$Site.vpn.adminCidr
    $employee = [string]$Site.vpn.employeeCidr
    $linuxInterface = [string]$Site.server.linuxInterface
    $sshPort = [int]$Site.server.sshPort
    $httpsPort = [int]$Site.server.httpsPort
    $serverNetwork = Get-CidrInfo ([string]$Site.server.gatewayCidr)
    $gateway = $serverNetwork.Address
    $serverAddress = [string]$Site.server.address
    $serverPrefix = $serverNetwork.Prefix
    $bootstrapUser = [string]$Site.server.bootstrapUser
    $packageMode = [string]$Site.packageMode
    return @"
#!/usr/bin/env bash
set -euo pipefail
test "`$(id -u)" -eq 0
if ! command -v nft >/dev/null 2>&1 || ! command -v sshd >/dev/null 2>&1 || ! command -v augenrules >/dev/null 2>&1; then
  if [ '${packageMode}' = 'online' ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nftables openssh-server auditd unattended-upgrades
  else
    printf '%s\n' 'Required Ubuntu packages are missing; set packageMode=online or install them offline first.' >&2
    exit 1
  fi
fi
install -d -m 0700 /etc/cz-safety /var/lib/cz-safety/backups
stamp="`$(date -u +%Y%m%dT%H%M%SZ)"
backup="/var/lib/cz-safety/backups/windows-bastion-`$stamp.tar.gz"
tar -czf "`$backup" \
  /etc/netplan /etc/nftables.conf /etc/ssh/sshd_config /etc/ssh/sshd_config.d /etc/sysctl.d /etc/audit/rules.d 2>/dev/null || true
test -s "`$backup"
printf '%s\n' "`$backup" > /var/lib/cz-safety/pending-windows-backup
cat > /etc/netplan/99-cz-safety-windows.yaml <<'CZ_NETPLAN'
network:
  version: 2
  ethernets:
    ${linuxInterface}:
      dhcp4: false
      dhcp6: false
      addresses: [${serverAddress}/${serverPrefix}]
      routes:
        - to: default
          via: ${gateway}
CZ_NETPLAN
chmod 0600 /etc/netplan/99-cz-safety-windows.yaml
cat > /etc/nftables.conf <<'CZ_NFT'
#!/usr/sbin/nft -f
flush ruleset
table inet cz_safety {
  chain input {
    type filter hook input priority filter; policy drop;
    ct state invalid drop
    ct state established,related accept
    iifname "lo" accept
    ip protocol icmp limit rate 20/second accept
    iifname "${linuxInterface}" ip saddr ${admin} tcp dport { ${sshPort}, ${httpsPort} } accept
    iifname "${linuxInterface}" ip saddr ${employee} tcp dport ${httpsPort} accept
    iifname "${linuxInterface}" ip saddr ${gateway}/32 tcp dport ${sshPort} accept comment "temporary Windows bootstrap path"
    limit rate 10/second log prefix "CZ-SAFETY-DROP " level info
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
  }
  chain output {
    type filter hook output priority filter; policy drop;
    ct state invalid drop
    ct state established,related accept
    oifname "lo" accept
    ip protocol icmp accept
    udp dport { 53, 123 } accept
    tcp dport { 53, 80, 443 } accept
  }
}
CZ_NFT
cat > /etc/ssh/sshd_config.d/60-cz-safety.conf <<'CZ_SSH'
Port ${sshPort}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowGroups safety-admin
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
GatewayPorts no
PermitTunnel no
CZ_SSH
cat > /etc/sysctl.d/60-cz-safety.conf <<'CZ_SYSCTL'
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.default.send_redirects=0
net.ipv4.conf.all.accept_source_route=0
net.ipv4.conf.default.accept_source_route=0
net.ipv4.tcp_syncookies=1
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
CZ_SYSCTL
cat > /etc/audit/rules.d/60-cz-safety.rules <<'CZ_AUDIT'
-w /etc/cz-safety/ -p wa -k cz_safety
-w /etc/nftables.conf -p wa -k cz_firewall
-w /etc/ssh/sshd_config -p wa -k cz_sshd
-w /etc/ssh/sshd_config.d/ -p wa -k cz_sshd
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/sudoers -p wa -k privilege
-w /etc/sudoers.d/ -p wa -k privilege
CZ_AUDIT
chmod 0640 /etc/audit/rules.d/60-cz-safety.rules
getent group safety-admin >/dev/null || groupadd --system safety-admin
id '${bootstrapUser}' >/dev/null 2>&1
usermod -aG safety-admin,sudo '${bootstrapUser}'
nft -c -f /etc/nftables.conf
sshd -t
netplan generate
sysctl --system >/dev/null
systemctl enable --now nftables ssh auditd unattended-upgrades
augenrules --load
nft -f /etc/nftables.conf
systemctl reload ssh
netplan apply
printf '%s\n' '{"status":"STAGED","source":"deploy-windows-bastion.ps1"}' > /var/lib/cz-safety/windows-bastion-stage.json
"@
}

function Get-WindowsPlan {
    param([object]$Site)
    $payload = Get-UbuntuHardeningPayload $Site
    $plan = [ordered]@{
        schemaVersion = 1
        script = "deploy-windows-bastion.ps1"
        topology = "windows-bastion"
        public = [ordered]@{
            interfaceAlias = $Site.public.interfaceAlias
            cidr = $Site.public.cidr
            gateway = $Site.public.gateway
            allowedInbound = @("UDP/$($Site.public.wireguardPort)")
        }
        vpn = [ordered]@{
            interfaceName = $Site.vpn.interfaceName
            address = $Site.vpn.address
            adminCidr = $Site.vpn.adminCidr
            employeeCidr = $Site.vpn.employeeCidr
        }
        server = [ordered]@{
            gatewayCidr = $Site.server.gatewayCidr
            address = $Site.server.address
            sshPort = $Site.server.sshPort
            httpsPort = $Site.server.httpsPort
            ubuntuHardeningSha256 = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($payload))).Replace("-", "").ToLowerInvariant())
        }
        bmc = [ordered]@{
            mode = $Site.bmc.mode
            address = "192.168.100.10"
            browserUrl = "$($Site.bmc.webScheme)://192.168.100.10"
        }
        runtimeSecrets = "generated outside repository"
        rollbackMinutes = [int]$Site.rollbackMinutes
    }
    return $plan
}

function Get-PlatformStatus {
    if (-not $IsWindowsPlatform) { return "PENDING_WINDOWS_SITE" }
    $required = @("Get-NetAdapter", "Get-NetIPAddress", "New-NetIPAddress", "Get-NetNat", "New-NetNat", "Get-NetFirewallRule", "New-NetFirewallRule", "Set-NetIPInterface")
    $missing = @($required | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -gt 0) { return "BLOCKED" }
    return "PASS"
}

function Invoke-Preflight {
    param([object]$Site)
    [void](Validate-SiteConfig $Site)
    $missing = [System.Collections.Generic.List[string]]::new()
    $missingArtifacts = [System.Collections.Generic.List[string]]::new()
    $status = Get-PlatformStatus
    if ($IsWindowsPlatform) {
        foreach ($command in @("Get-NetAdapter", "Get-NetIPAddress", "New-NetNat", "New-NetFirewallRule", "ssh.exe")) {
            if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { $missing.Add($command) }
        }
        foreach ($path in @([string]$Site.server.bootstrapKeyPath, [string]$Site.server.knownHostsPath, [string]$Site.wireguard.wireguardExe, [string]$Site.wireguard.wgExe)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $missingArtifacts.Add($path) }
        }
        $adapters = @([string]$Site.public.interfaceAlias, [string]$Site.server.lanInterfaceAlias)
        if ([string]$Site.bmc.mode -in @("routed", "local-browser")) { $adapters += [string]$Site.bmc.interfaceAlias }
        foreach ($alias in $adapters) {
            if (-not (Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue)) { $missingArtifacts.Add("adapter:$alias") }
        }
        if ($missing.Count -gt 0 -or $missingArtifacts.Count -gt 0) { $status = "BLOCKED" }
    }
    [ordered]@{
        script = "deploy-windows-bastion.ps1"
        scriptVersion = $ScriptVersion
        status = $status
        publicInterface = $Site.public.interfaceAlias
        publicCidr = $Site.public.cidr
        wireguardPort = $Site.public.wireguardPort
        bmcAddress = "192.168.100.10"
        bmcMode = $Site.bmc.mode
        missingCommands = $missing
        missingArtifacts = $missingArtifacts
    } | ConvertTo-Json -Depth 6
}

function Assert-SelfTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "self-test failed: $Message" }
}

function Invoke-SelfTest {
    $sample = @'
{
  "schemaVersion": 1,
  "topology": "windows-bastion",
  "public": {"interfaceAlias":"WAN","cidr":"203.0.113.106/30","gateway":"203.0.113.105","wireguardPort":51820},
  "vpn": {"interfaceName":"CZ-Safety-WG","address":"10.203.0.1/24","adminCidr":"10.203.0.0/26","employeeCidr":"10.203.0.128/25"},
  "server": {"lanInterfaceAlias":"LAN","gatewayCidr":"10.203.10.1/24","address":"10.203.10.10","linuxInterface":"eno1","sshPort":22,"httpsPort":443,"bootstrapUser":"safety-bootstrap","bootstrapKeyPath":"C:\\keys\\bootstrap","knownHostsPath":"C:\\keys\\known_hosts"},
  "bmc": {"mode":"routed","interfaceAlias":"BMC","gatewayCidr":"192.168.100.1/24","address":"192.168.100.10","webScheme":"https"},
  "wireguard": {"wireguardExe":"C:\\Program Files\\WireGuard\\wireguard.exe","wgExe":"C:\\Program Files\\WireGuard\\wg.exe"},
  "packageMode":"skip",
  "rollbackMinutes":5
}
'@ | ConvertFrom-Json
    Assert-SelfTest (Validate-SiteConfig $sample) "valid sample rejected"
    $plan = Get-WindowsPlan $sample
    Assert-SelfTest ($plan.public.allowedInbound.Count -eq 1) "WAN exposure is not WireGuard-only"
    Assert-SelfTest ($plan.bmc.address -eq "192.168.100.10") "BMC address changed"
    $payload = Get-UbuntuHardeningPayload $sample
    Assert-SelfTest ($payload.Contains("policy drop")) "Ubuntu default drop missing"
    Assert-SelfTest ($payload.Contains("PasswordAuthentication no")) "Ubuntu SSH password hardening missing"
    Assert-SelfTest (-not $payload.Contains("udp dport { 53, 123, 443 }")) "embedded Ubuntu strict egress unexpectedly allows UDP/443"
    $customPortSample = $sample | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $customPortSample.server.sshPort = 2222
    $customPortPayload = Get-UbuntuHardeningPayload $customPortSample
    Assert-SelfTest ($customPortPayload.Contains("Port 2222")) "custom SSH port missing from sshd drop-in"
    Assert-SelfTest ($customPortPayload.Contains("tcp dport { 2222, 443 }")) "custom SSH port missing from nftables"
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    if ($bash) {
        & $bash.Source -n -c $payload
        Assert-SelfTest ($LASTEXITCODE -eq 0) "embedded Ubuntu hardening payload has invalid Bash syntax"
    }
    $invalid = $sample | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $invalid.public.cidr = "203.0.113.104/30"
    $rejected = $false
    try { [void](Validate-SiteConfig $invalid) } catch { $rejected = $true }
    Assert-SelfTest $rejected "network address was accepted"
    $alternate = $sample | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $alternate.public.cidr = "198.51.100.10/30"
    $alternate.public.gateway = "198.51.100.9"
    Assert-SelfTest (Validate-SiteConfig $alternate) "valid /30 with different final octets was rejected"
    Write-Info "self-test PASS"
}

function Ensure-Directory {
    param([string]$Path, [switch]$Secret)
    if (-not (Test-Path -LiteralPath $Path)) { [void](New-Item -ItemType Directory -Path $Path -Force) }
    if ($Secret -and $IsWindowsPlatform) {
        & icacls.exe $Path /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
    }
}

function Get-StatePaths {
    return [ordered]@{
        Config = Join-Path $RuntimeRoot "site.windows.json"
        Peers = Join-Path $RuntimeRoot "peers.json"
        Secrets = Join-Path $RuntimeRoot "secrets"
        WireGuard = Join-Path $RuntimeRoot "wireguard"
        Exports = Join-Path $RuntimeRoot "exports"
        Backups = Join-Path $RuntimeRoot "backups"
        Evidence = Join-Path $RuntimeRoot "evidence"
        Pending = Join-Path $RuntimeRoot "pending.json"
    }
}

function Get-PeerState {
    $paths = Get-StatePaths
    if (-not (Test-Path -LiteralPath $paths.Peers)) { return @() }
    $data = Get-Content -LiteralPath $paths.Peers -Raw | ConvertFrom-Json
    return @($data)
}

function Save-PeerState {
    param([array]$Peers)
    $paths = Get-StatePaths
    Ensure-Directory (Split-Path -Parent $paths.Peers) -Secret
    $Peers | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $paths.Peers -Encoding UTF8
}

function Get-NextPeerAddress {
    param([object]$Site, [string]$PeerRole, [array]$Peers)
    $range = Get-CidrInfo ($(if ($PeerRole -eq "Admin") { [string]$Site.vpn.adminCidr } else { [string]$Site.vpn.employeeCidr }))
    $used = @{}
    foreach ($peer in $Peers) { $used[[string]$peer.address] = $true }
    $start = $range.NetworkValue + 1
    if ($PeerRole -eq "Admin") { $start++ }
    for ($value = $start; $value -lt $range.BroadcastValue; $value++) {
        $candidate = ConvertFrom-IPv4UInt32 ([uint32]$value)
        if (-not $used.ContainsKey($candidate)) { return $candidate }
    }
    throw "No unused $PeerRole peer address remains"
}

function Invoke-Wg {
    param([object]$Site, [string[]]$Arguments, [string]$InputText = "")
    $wgExe = [string]$Site.wireguard.wgExe
    if (-not (Test-Path -LiteralPath $wgExe -PathType Leaf)) { throw "wg.exe not found: $wgExe" }
    if ($InputText) { return $InputText | & $wgExe @Arguments }
    return & $wgExe @Arguments
}

function Ensure-ServerKeys {
    param([object]$Site)
    $paths = Get-StatePaths
    Ensure-Directory $paths.Secrets -Secret
    $privatePath = Join-Path $paths.Secrets "wg-server.key"
    $publicPath = Join-Path $paths.Secrets "wg-server.pub"
    if (-not (Test-Path -LiteralPath $privatePath)) {
        $private = (Invoke-Wg $Site @("genkey")).Trim()
        $public = (Invoke-Wg $Site @("pubkey") $private).Trim()
        Set-Content -LiteralPath $privatePath -Value $private -Encoding ascii
        Set-Content -LiteralPath $publicPath -Value $public -Encoding ascii
    }
    return [pscustomobject]@{
        Private = (Get-Content -LiteralPath $privatePath -Raw).Trim()
        Public = (Get-Content -LiteralPath $publicPath -Raw).Trim()
    }
}

function Write-WireGuardConfig {
    param([object]$Site)
    $paths = Get-StatePaths
    Ensure-Directory $paths.WireGuard -Secret
    $keys = Ensure-ServerKeys $Site
    $peers = Get-PeerState
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("[Interface]")
    $lines.Add("PrivateKey = $($keys.Private)")
    $lines.Add("ListenPort = $($Site.public.wireguardPort)")
    $lines.Add("Address = $($Site.vpn.address)")
    foreach ($peer in $peers) {
        $lines.Add("")
        $lines.Add("# name=$($peer.name) role=$($peer.role)")
        $lines.Add("[Peer]")
        $lines.Add("PublicKey = $($peer.publicKey)")
        $lines.Add("PresharedKey = $($peer.presharedKey)")
        $lines.Add("AllowedIPs = $($peer.address)/32")
    }
    $path = Join-Path $paths.WireGuard "$($Site.vpn.interfaceName).conf"
    $lines | Set-Content -LiteralPath $path -Encoding ascii
    return $path
}

function Backup-WindowsState {
    param([object]$Site)
    $paths = Get-StatePaths
    Ensure-Directory $paths.Backups -Secret
    $id = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $dir = Join-Path $paths.Backups $id
    Ensure-Directory $dir -Secret
    if ($IsWindowsPlatform) {
        $firewallBackup = Join-Path $dir "firewall.wfw"
        & netsh.exe advfirewall export $firewallBackup | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $firewallBackup)) { throw "Unable to back up Windows Firewall; refusing to continue" }
        Get-NetIPAddress | Select-Object InterfaceAlias, AddressFamily, IPAddress, PrefixLength | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "addresses.json")
        Get-NetRoute | Select-Object InterfaceAlias, DestinationPrefix, NextHop, RouteMetric | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "routes.json")
        Get-NetNat | Select-Object Name, InternalIPInterfaceAddressPrefix | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "nat.json")
    }
    [ordered]@{ backupId = $id; config = $Config; createdAtUtc = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $paths.Pending
    return $id
}

function Register-AutomaticRollback {
    param([object]$Site, [string]$Id)
    if (-not $IsWindowsPlatform) { return }
    $taskName = "CZ-Safety-Rollback-$Id"
    $runtimeScript = Join-Path $RuntimeRoot "deploy-windows-bastion.ps1"
    $runtimeConfig = Join-Path $RuntimeRoot "site.windows.json"
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runtimeScript`" -Action Rollback -Config `"$runtimeConfig`" -BackupId `"$Id`""
    $actionObject = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes([int]$Site.rollbackMinutes)
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $actionObject -Trigger $trigger -Principal $principal -Force | Out-Null
}

function Remove-AutomaticRollback {
    $paths = Get-StatePaths
    if (-not (Test-Path -LiteralPath $paths.Pending)) { return }
    $pending = Get-Content -LiteralPath $paths.Pending -Raw | ConvertFrom-Json
    if ($IsWindowsPlatform) {
        Unregister-ScheduledTask -TaskName "CZ-Safety-Rollback-$($pending.backupId)" -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $paths.Pending -Force
}

function Ensure-IPv4Address {
    param([string]$InterfaceAlias, [string]$Cidr, [string]$DefaultGateway = "", [switch]$AllowAdditional)
    $info = Get-CidrInfo $Cidr
    $existing = @(Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction SilentlyContinue)
    $conflicts = @($existing | Where-Object { $_.IPAddress -ne $info.Address -and $_.PrefixOrigin -ne "WellKnown" })
    if (-not $AllowAdditional -and $conflicts.Count -gt 0) { throw "Interface $InterfaceAlias has conflicting IPv4 addresses; refusing automatic replacement" }
    if (-not ($existing | Where-Object { $_.IPAddress -eq $info.Address -and $_.PrefixLength -eq $info.Prefix })) {
        $params = @{ InterfaceAlias = $InterfaceAlias; IPAddress = $info.Address; PrefixLength = $info.Prefix }
        if ($DefaultGateway) { $params.DefaultGateway = $DefaultGateway }
        New-NetIPAddress @params | Out-Null
    }
}

function Configure-WindowsFirewall {
    param([object]$Site)
    $vpnGateway = (Get-CidrInfo ([string]$Site.vpn.address)).Address
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
        Where-Object { $_.Group -ne $FirewallGroup } |
        Disable-NetFirewallRule
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow -LogBlocked True -LogAllowed True -LogMaxSizeKilobytes 32767
    New-NetFirewallRule -DisplayName "CZ Safety WireGuard WAN" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol UDP -LocalPort ([int]$Site.public.wireguardPort) -InterfaceAlias ([string]$Site.public.interfaceAlias) | Out-Null
    New-NetFirewallRule -DisplayName "CZ Safety Admin RDP over VPN" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $vpnGateway -LocalPort 3389 -RemoteAddress ([string]$Site.vpn.adminCidr) -InterfaceAlias ([string]$Site.vpn.interfaceName) | Out-Null
    New-NetFirewallRule -DisplayName "CZ Safety Admin private targets over VPN" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ([string]$Site.server.address) -LocalPort ([int]$Site.server.sshPort),([int]$Site.server.httpsPort) -RemoteAddress ([string]$Site.vpn.adminCidr) -InterfaceAlias ([string]$Site.vpn.interfaceName) | Out-Null
    New-NetFirewallRule -DisplayName "CZ Safety Employee HTTPS over VPN" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ([string]$Site.server.address) -LocalPort ([int]$Site.server.httpsPort) -RemoteAddress ([string]$Site.vpn.employeeCidr) -InterfaceAlias ([string]$Site.vpn.interfaceName) | Out-Null
    New-NetFirewallRule -DisplayName "CZ Safety Block SMB on WAN" -Group $FirewallGroup -Direction Inbound -Action Block -Protocol TCP -LocalPort 445 -InterfaceAlias ([string]$Site.public.interfaceAlias) | Out-Null
    New-NetFirewallRule -DisplayName "CZ Safety Block WinRM on WAN" -Group $FirewallGroup -Direction Inbound -Action Block -Protocol TCP -LocalPort 5985,5986 -InterfaceAlias ([string]$Site.public.interfaceAlias) | Out-Null
}

function Invoke-UbuntuHardening {
    param([object]$Site)
    $payload = Get-UbuntuHardeningPayload $Site
    if ((Invoke-UbuntuBootstrapScript $Site $payload) -ne 0) { throw "Ubuntu hardening failed over the private bootstrap SSH path" }
}

function Invoke-UbuntuBootstrapScript {
    param([object]$Site, [string]$Payload)
    $target = "$($Site.server.bootstrapUser)@$($Site.server.address)"
    $sshArgs = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=$($Site.server.knownHostsPath)", "-i", [string]$Site.server.bootstrapKeyPath, $target, "sudo -n bash -s")
    $output = $Payload | & ssh.exe @sshArgs
    $exitCode = $LASTEXITCODE
    if ($output) { Write-Host ($output -join [Environment]::NewLine) }
    return [int]$exitCode
}

function Invoke-Apply {
    param([object]$Site)
    [void](Validate-SiteConfig $Site)
    if (-not $ConfirmConsole) { throw "Apply requires -ConfirmConsole" }
    if (-not $IsWindowsPlatform) { throw "Apply is only allowed on the target Windows bastion" }
    if (-not (Test-Administrator)) { throw "Apply requires an elevated PowerShell session" }
    if (Test-DocumentationWan $Site) { throw "Refusing to apply a documentation/test WAN address" }
    if ((Get-PlatformStatus) -ne "PASS") { throw "Required Windows networking modules are missing" }
    foreach ($alias in @([string]$Site.public.interfaceAlias, [string]$Site.server.lanInterfaceAlias)) {
        if (-not (Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue)) { throw "Network adapter not found: $alias" }
    }
    if ([string]$Site.bmc.mode -in @("routed", "local-browser") -and -not (Get-NetAdapter -Name ([string]$Site.bmc.interfaceAlias) -ErrorAction SilentlyContinue)) {
        throw "BMC adapter not found: $($Site.bmc.interfaceAlias)"
    }
    if (-not (Test-Path -LiteralPath ([string]$Site.server.bootstrapKeyPath))) { throw "Ubuntu bootstrap SSH key not found" }
    if (-not (Test-Path -LiteralPath ([string]$Site.server.knownHostsPath))) { throw "Verified Ubuntu known_hosts file not found" }
    if (-not (Test-Path -LiteralPath ([string]$Site.wireguard.wireguardExe)) -or -not (Test-Path -LiteralPath ([string]$Site.wireguard.wgExe))) {
        throw "WireGuard for Windows is not installed at the configured paths"
    }
    $foreignInboundAllowCount = @(
        Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
            Where-Object { $_.Group -ne $FirewallGroup }
    ).Count
    if ($foreignInboundAllowCount -gt 0) {
        Write-Warning "Apply will disable $foreignInboundAllowCount enabled inbound Allow rules outside CZ-Safety across all firewall profiles; the rollback backup restores them"
    }
    Ensure-Directory $RuntimeRoot -Secret
    $id = Backup-WindowsState $Site
    $runtimeConfig = Join-Path $RuntimeRoot "site.windows.json"
    if ([IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Config).Path) -ne [IO.Path]::GetFullPath($runtimeConfig)) {
        Copy-Item -LiteralPath $Config -Destination $runtimeConfig -Force
    }
    $runtimeScript = Join-Path $RuntimeRoot "deploy-windows-bastion.ps1"
    if ([IO.Path]::GetFullPath($ScriptPath) -ne [IO.Path]::GetFullPath($runtimeScript)) {
        Copy-Item -LiteralPath $ScriptPath -Destination $runtimeScript -Force
    }
    Register-AutomaticRollback $Site $id
    $wgConfig = Write-WireGuardConfig $Site
    Ensure-IPv4Address ([string]$Site.public.interfaceAlias) ([string]$Site.public.cidr) ([string]$Site.public.gateway)
    Ensure-IPv4Address ([string]$Site.server.lanInterfaceAlias) ([string]$Site.server.gatewayCidr)
    Set-NetIPInterface -InterfaceAlias ([string]$Site.server.lanInterfaceAlias) -AddressFamily IPv4 -Forwarding Enabled
    if ([string]$Site.bmc.mode -in @("routed", "local-browser")) {
        Ensure-IPv4Address ([string]$Site.bmc.interfaceAlias) ([string]$Site.bmc.gatewayCidr)
        Set-NetIPInterface -InterfaceAlias ([string]$Site.bmc.interfaceAlias) -AddressFamily IPv4 -Forwarding Enabled
    } elseif ([string]$Site.bmc.mode -eq "flat-bmc") {
        Ensure-IPv4Address ([string]$Site.server.lanInterfaceAlias) ([string]$Site.bmc.gatewayCidr) -AllowAdditional
    }
    $existingNat = Get-NetNat -Name "CZ-Safety-NAT" -ErrorAction SilentlyContinue
    if ($existingNat) { throw "A pre-existing CZ-Safety-NAT exists; remove or rename it after manual review" }
    New-NetNat -Name "CZ-Safety-NAT" -InternalIPInterfaceAddressPrefix ((Get-CidrInfo ([string]$Site.server.gatewayCidr)).Network + "/" + (Get-CidrInfo ([string]$Site.server.gatewayCidr)).Prefix) | Out-Null
    & ([string]$Site.wireguard.wireguardExe) /installtunnelservice $wgConfig
    if ($LASTEXITCODE -ne 0) { throw "WireGuard tunnel service installation failed" }
    $wgAdapter = $null
    foreach ($attempt in 1..20) {
        $wgAdapter = Get-NetAdapter -Name ([string]$Site.vpn.interfaceName) -ErrorAction SilentlyContinue
        if ($wgAdapter) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $wgAdapter) { throw "WireGuard adapter did not appear after tunnel service installation" }
    Set-NetIPInterface -InterfaceAlias ([string]$Site.vpn.interfaceName) -AddressFamily IPv4 -Forwarding Enabled
    Configure-WindowsFirewall $Site
    Invoke-UbuntuHardening $Site
    Write-Info "Apply staged successfully. Automatic rollback is armed for $($Site.rollbackMinutes) minutes."
    Write-Info "Run Verify, test a real external admin peer, then run Confirm."
}

function Write-AcceptanceReport {
    param([object]$Site, [string]$Status, [string]$Directory)
    Ensure-Directory $Directory -Secret
    $report = [ordered]@{
        schemaVersion = 1
        script = "deploy-windows-bastion.ps1"
        topology = "windows-bastion"
        status = $Status
        developmentChecks = "RUN_SEPARATELY"
        windowsRuntime = Get-PlatformStatus
        ubuntuRuntime = if ($IsWindowsPlatform) { "PENDING_SITE_VERIFY" } else { "PENDING_UBUNTU_SITE" }
        bmcRuntime = if ([string]$Site.bmc.mode -eq "disabled") { "DISABLED_SAFE" } else { "PENDING_SITE" }
        publicNetworkRuntime = "PENDING_SITE"
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    $path = Join-Path $Directory "acceptance.json"
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Invoke-Verify {
    param([object]$Site)
    [void](Validate-SiteConfig $Site)
    $paths = Get-StatePaths
    $dir = if ($OutputDir) { $OutputDir } else { Join-Path $paths.Evidence ((Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")) }
    if (-not $IsWindowsPlatform) {
        $path = Write-AcceptanceReport $Site "PENDING_WINDOWS_SITE" $dir
        Write-Info "Acceptance report: $path"
        return "PENDING_WINDOWS_SITE"
    }
    $failed = $false
    if (-not (Get-NetIPAddress -InterfaceAlias ([string]$Site.public.interfaceAlias) -IPAddress ((Get-CidrInfo ([string]$Site.public.cidr)).Address) -ErrorAction SilentlyContinue)) { $failed = $true }
    if (-not (Get-NetNat -Name "CZ-Safety-NAT" -ErrorAction SilentlyContinue)) { $failed = $true }
    if (-not (Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)) { $failed = $true }
    $tunnelService = Get-Service -Name "WireGuardTunnel*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$($Site.vpn.interfaceName)*" }
    if (-not $tunnelService) { $failed = $true }
    $remoteProbe = @'
set -euo pipefail
nft list table inet cz_safety >/dev/null
sshd -T | grep -q '^passwordauthentication no$'
test -f /etc/netplan/99-cz-safety-windows.yaml
'@
    if ((Test-Path -LiteralPath $paths.Pending) -and (Invoke-UbuntuBootstrapScript $Site $remoteProbe) -ne 0) { $failed = $true }
    $status = if ($failed) { "FAIL" } else { "PENDING_EXTERNAL_VERIFY" }
    $path = Write-AcceptanceReport $Site $status $dir
    Write-Info "Acceptance report: $path"
    if ($failed) { throw "Local Windows verification failed" }
    return $status
}

function Invoke-Confirm {
    param([object]$Site)
    if (-not $IsWindowsPlatform) { throw "Confirm is only allowed on the target Windows bastion" }
    if (-not $ConfirmExternal) { throw "Confirm requires -ConfirmExternal after a real off-host WireGuard, SSH, employee-denial, and BMC test" }
    $status = Invoke-Verify $Site
    if ($status -eq "FAIL") { throw "Cannot confirm a failed deployment" }
    $removeBootstrap = @'
set -euo pipefail
sed -i '/temporary Windows bootstrap path/d' /etc/nftables.conf
nft -c -f /etc/nftables.conf
nft -f /etc/nftables.conf
rm -f /var/lib/cz-safety/pending-windows-backup
'@
    if ((Invoke-UbuntuBootstrapScript $Site $removeBootstrap) -ne 0) { throw "Failed to remove the temporary Ubuntu bootstrap rule" }
    Remove-AutomaticRollback
    Write-Info "Configuration confirmed after local verification. External role checks remain evidence requirements."
}

function Invoke-Rollback {
    param([object]$Site)
    if (-not $IsWindowsPlatform) { throw "Rollback is only allowed on the target Windows bastion" }
    $paths = Get-StatePaths
    $resolvedBackupId = $BackupId
    if (-not $resolvedBackupId) {
        if (-not (Test-Path -LiteralPath $paths.Pending)) { throw "No pending backup" }
        $resolvedBackupId = [string](Get-Content -LiteralPath $paths.Pending -Raw | ConvertFrom-Json).backupId
    }
    $dir = Join-Path $paths.Backups $resolvedBackupId
    if (-not (Test-Path -LiteralPath $dir)) { throw "Backup not found: $resolvedBackupId" }
    if (Test-Path -LiteralPath $paths.Pending) {
        $ubuntuRollback = @'
set -euo pipefail
backup="$(cat /var/lib/cz-safety/pending-windows-backup)"
test -s "$backup"
rm -f /etc/netplan/99-cz-safety-windows.yaml /etc/ssh/sshd_config.d/60-cz-safety.conf /etc/sysctl.d/60-cz-safety.conf /etc/audit/rules.d/60-cz-safety.rules /etc/nftables.conf
tar -xzf "$backup" -C /
rm -f /var/lib/cz-safety/pending-windows-backup
nohup bash -c 'sleep 2; sysctl --system >/dev/null 2>&1 || true; netplan apply >/dev/null 2>&1 || true; nft -f /etc/nftables.conf >/dev/null 2>&1 || true; systemctl reload ssh >/dev/null 2>&1 || true' >/dev/null 2>&1 &
'@
        if ((Invoke-UbuntuBootstrapScript $Site $ubuntuRollback) -ne 0) {
            Write-Warning "Ubuntu automatic rollback could not be started; recover it from the onsite console using its backup archive"
        }
    }
    $firewall = Join-Path $dir "firewall.wfw"
    Get-NetNat -Name "CZ-Safety-NAT" -ErrorAction SilentlyContinue | Remove-NetNat -Confirm:$false
    Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    & ([string]$Site.wireguard.wireguardExe) /uninstalltunnelservice ([string]$Site.vpn.interfaceName) 2>$null
    $priorAddressesPath = Join-Path $dir "addresses.json"
    $priorAddresses = if (Test-Path -LiteralPath $priorAddressesPath) { @(Get-Content -LiteralPath $priorAddressesPath -Raw | ConvertFrom-Json) } else { @() }
    $managed = @(
        @([string]$Site.public.interfaceAlias, [string]$Site.public.cidr),
        @([string]$Site.server.lanInterfaceAlias, [string]$Site.server.gatewayCidr)
    )
    if ([string]$Site.bmc.mode -in @("routed", "local-browser")) {
        $managed += ,@([string]$Site.bmc.interfaceAlias, [string]$Site.bmc.gatewayCidr)
    } elseif ([string]$Site.bmc.mode -eq "flat-bmc") {
        $managed += ,@([string]$Site.server.lanInterfaceAlias, [string]$Site.bmc.gatewayCidr)
    }
    foreach ($entry in $managed) {
        $info = Get-CidrInfo $entry[1]
        $existed = $priorAddresses | Where-Object { $_.InterfaceAlias -eq $entry[0] -and $_.IPAddress -eq $info.Address -and [int]$_.PrefixLength -eq $info.Prefix }
        if (-not $existed) {
            Get-NetIPAddress -InterfaceAlias $entry[0] -IPAddress $info.Address -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
        }
    }
    if (Test-Path -LiteralPath $firewall) { & netsh.exe advfirewall import $firewall | Out-Null }
    Remove-AutomaticRollback
    Write-Info "Rollback restored the firewall and removed CZ-Safety NAT, tunnel, rules, and addresses that were added by this run. Evidence: $dir"
}

function Invoke-PeerAdd {
    param([object]$Site)
    if (-not $PeerName -or $PeerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$') { throw "A safe -PeerName is required" }
    if (-not $IsWindowsPlatform) { throw "PeerAdd requires the target Windows bastion" }
    $peers = @(Get-PeerState)
    if ($peers | Where-Object { $_.name -eq $PeerName }) { throw "Peer already exists: $PeerName" }
    $address = Get-NextPeerAddress $Site $Role $peers
    $private = (Invoke-Wg $Site @("genkey")).Trim()
    $public = (Invoke-Wg $Site @("pubkey") $private).Trim()
    $psk = (Invoke-Wg $Site @("genpsk")).Trim()
    $keys = Ensure-ServerKeys $Site
    $peer = [pscustomobject]@{ name = $PeerName; role = $Role; address = $address; publicKey = $public; presharedKey = $psk }
    Save-PeerState @($peers + $peer)
    $wgConfig = Write-WireGuardConfig $Site
    $paths = Get-StatePaths
    Ensure-Directory $paths.Exports -Secret
    $vpnGateway = (Get-CidrInfo ([string]$Site.vpn.address)).Address
    $allowed = if ($Role -eq "Admin") { "$vpnGateway/32, $($Site.server.address)/32" } else { "$($Site.server.address)/32" }
    @"
[Interface]
Address = $address/32
PrivateKey = $private

[Peer]
PublicKey = $($keys.Public)
PresharedKey = $psk
Endpoint = $((Get-CidrInfo ([string]$Site.public.cidr)).Address):$($Site.public.wireguardPort)
AllowedIPs = $allowed
PersistentKeepalive = 25
"@ | Set-Content -LiteralPath (Join-Path $paths.Exports "$PeerName.conf") -Encoding ascii
    Restart-WireGuardTunnelForPeerChange $Site $wgConfig
    Write-Info "Peer created: $PeerName ($Role, $address)"
}

function Restart-WireGuardTunnelForPeerChange {
    param([object]$Site, [string]$ConfigPath)
    Write-Warning "Updating peers reinstalls the WireGuard tunnel service and briefly disconnects every active peer; perform this in a maintenance window"
    & ([string]$Site.wireguard.wireguardExe) /uninstalltunnelservice ([string]$Site.vpn.interfaceName) 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Warning "WireGuard tunnel uninstall returned exit code $LASTEXITCODE; attempting a clean install" }
    & ([string]$Site.wireguard.wireguardExe) /installtunnelservice $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw "WireGuard tunnel service reinstall failed after the peer change" }
}

function Invoke-PeerRevoke {
    param([object]$Site)
    if (-not $PeerName) { throw "-PeerName is required" }
    if (-not $IsWindowsPlatform) { throw "PeerRevoke requires the target Windows bastion" }
    $peers = @(Get-PeerState)
    if (-not ($peers | Where-Object { $_.name -eq $PeerName })) { throw "Peer not found: $PeerName" }
    Save-PeerState @($peers | Where-Object { $_.name -ne $PeerName })
    $paths = Get-StatePaths
    Remove-Item -LiteralPath (Join-Path $paths.Exports "$PeerName.conf") -Force -ErrorAction SilentlyContinue
    $wgConfig = Write-WireGuardConfig $Site
    Restart-WireGuardTunnelForPeerChange $Site $wgConfig
    Write-Info "Peer revoked: $PeerName"
}

function Invoke-Evidence {
    param([object]$Site)
    $paths = Get-StatePaths
    $dir = if ($OutputDir) { $OutputDir } else { Join-Path $paths.Evidence ((Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")) }
    Ensure-Directory $dir -Secret
    Invoke-Preflight $Site | Set-Content -LiteralPath (Join-Path $dir "preflight.json") -Encoding UTF8
    Get-WindowsPlan $Site | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dir "plan.json") -Encoding UTF8
    if ($IsWindowsPlatform) {
        Get-NetIPAddress | Select-Object InterfaceAlias, AddressFamily, IPAddress, PrefixLength | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "addresses.json")
        Get-NetRoute | Select-Object InterfaceAlias, DestinationPrefix, NextHop, RouteMetric | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "routes.json")
        Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction, Action | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir "firewall-rules.json")
    }
    $status = if ($IsWindowsPlatform) { "PENDING_SITE_VERIFY" } else { "READY_FOR_SITE" }
    [void](Write-AcceptanceReport $Site $status $dir)
    Write-Info "Evidence directory: $dir"
}

function Invoke-PrepareBundle {
    param([object]$Site)
    $dir = if ($OutputDir) { $OutputDir } else { Join-Path $ScriptDir "dist/windows-bastion" }
    Ensure-Directory $dir
    Copy-Item -LiteralPath $ScriptPath -Destination (Join-Path $dir (Split-Path -Leaf $ScriptPath)) -Force
    Copy-Item -LiteralPath $Config -Destination (Join-Path $dir "site.windows.json") -Force
    if ($Site.PSObject.Properties.Name -contains "wireguardInstallerPath" -and $Site.wireguardInstallerPath -and (Test-Path -LiteralPath $Site.wireguardInstallerPath)) {
        Copy-Item -LiteralPath $Site.wireguardInstallerPath -Destination $dir -Force
    }
    Get-ChildItem -LiteralPath $dir -File | ForEach-Object {
        "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant())  $($_.Name)"
    } | Set-Content -LiteralPath (Join-Path $dir "SHA256SUMS") -Encoding ascii
    Write-Info "Windows offline bundle directory: $dir"
}

function Invoke-Main {
    if ($Action -eq "SelfTest") { Invoke-SelfTest; return }
    $site = Read-SiteConfig $Config
    [void](Validate-SiteConfig $site)
    switch ($Action) {
        "Preflight" { Invoke-Preflight $site }
        "Plan" { Get-WindowsPlan $site | ConvertTo-Json -Depth 8 }
        "PrepareBundle" { Invoke-PrepareBundle $site }
        "Apply" { Invoke-Apply $site }
        "Verify" { [void](Invoke-Verify $site) }
        "Confirm" { Invoke-Confirm $site }
        "Rollback" { Invoke-Rollback $site }
        "PeerAdd" { Invoke-PeerAdd $site }
        "PeerRevoke" { Invoke-PeerRevoke $site }
        "Evidence" { Invoke-Evidence $site }
        default { throw "Unsupported action: $Action" }
    }
}

Invoke-Main
