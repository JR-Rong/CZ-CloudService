[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $OutputDir) { $OutputDir = Join-Path $env:USERPROFILE "CZ-Safety-USB" }

function Write-Step { param([string]$Message); Write-Host "`n$([char]0x2501)$([char]0x2501) $Message $([char]0x2501)$([char]0x2501)" -ForegroundColor Cyan }
function Write-OK   { param([string]$Message); Write-Host "$([char]0x2713) $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message); Write-Host "$([char]0x26A0) $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message); Write-Host "$([char]0x2717) $Message" -ForegroundColor Red; exit 1 }

function New-VerifiedEd25519Key {
    param([string]$Path, [string]$Comment)
    & $sshKeygen.Source -q -t ed25519 -f $Path -N '' -C $Comment
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed while creating $Path" }
    $derivedPublicKey = & $sshKeygen.Source -y -P '' -f $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $derivedPublicKey) {
        throw "generated key cannot be loaded with an empty passphrase: $Path"
    }
}

# ── Prerequisites ──────────────────────────────────────────────
Write-Step "检查本机工具"

$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
if (-not $sshKeygen) { Write-Err "需要 ssh-keygen（Windows 10+ 自带 OpenSSH，如缺失请在 设置→应用→可选功能 中添加 OpenSSH 客户端）" }
Write-OK "ssh-keygen 可用"

$python3 = Get-Command python3.exe -ErrorAction SilentlyContinue
if (-not $python3) { $python3 = Get-Command python.exe -ErrorAction SilentlyContinue }
if (-not $python3) { Write-Warn "python3 未找到；将跳过 Windows 配置模板自动填充（不影响密钥生成）" }

$wgExe = Get-Command wg.exe -ErrorAction SilentlyContinue
if ($wgExe) { Write-OK "WireGuard 已安装" }
else { Write-Warn "WireGuard 未安装；部署完成后需要用它导入 peer 配置。下载：https://www.wireguard.com/install/" }

$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$dangerousOutputDirs = @(
    [IO.Path]::GetPathRoot($OutputDir),
    [IO.Path]::GetFullPath($env:USERPROFILE),
    [IO.Path]::GetFullPath((Get-Location).Path)
)
if ($dangerousOutputDirs | Where-Object { [string]::Equals($_, $OutputDir, [StringComparison]::OrdinalIgnoreCase) }) {
    Write-Err "拒绝危险输出目录：$OutputDir"
}
if (Test-Path -LiteralPath $OutputDir) { Write-Err "$OutputDir 已存在；脚本不会覆盖或删除现有目录，请换一个新目录" }
[void](New-Item -ItemType Directory -Path $OutputDir)

# ── SSH 密钥生成 ──────────────────────────────────────────────
Write-Step "生成 SSH 密钥"

$adminKeyName = "admin_ed25519"
$bootstrapKeyName = "bootstrap_ed25519"

$userSshDir = Join-Path $env:USERPROFILE ".ssh"
$adminKeyDir = $userSshDir
[void](New-Item -ItemType Directory -Path $adminKeyDir -Force)
$adminKeyPath = Join-Path $adminKeyDir $adminKeyName
$userSshKey = Join-Path $userSshDir $adminKeyName

if (Test-Path -LiteralPath $userSshKey) {
    if (-not (Test-Path -LiteralPath "$userSshKey.pub")) { throw "existing Admin private key has no public key: $userSshKey.pub" }
    Write-OK "复用已有 Admin SSH 密钥：$userSshKey"
} else {
    New-VerifiedEd25519Key $adminKeyPath "admin@cz-safety-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd'))"
    Write-OK "已在本机生成 Admin SSH 密钥对（不会写入 USB 或 Desktop）"
}
$adminFingerprint = & $sshKeygen.Source -lf "$adminKeyPath.pub" 2>&1
if ($LASTEXITCODE -ne 0 -or $adminFingerprint -notmatch 'ED25519') { throw "Admin key must be Ed25519: $adminKeyPath" }

$bootstrapKeyDir = Join-Path $OutputDir "FOR-WINDOWS-BASTION"
[void](New-Item -ItemType Directory -Path $bootstrapKeyDir -Force)
$bootstrapKeyPath = Join-Path $bootstrapKeyDir $bootstrapKeyName
New-VerifiedEd25519Key $bootstrapKeyPath "bootstrap@cz-safety-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd'))"
Write-OK "已生成 Bootstrap SSH 密钥对（仅 Windows 跳板拓扑使用）"

# ── Ubuntu 直连服务器配置 ─────────────────────────────────────
Write-Step "准备 Ubuntu 直连部署材料"

$ubuntuDir = Join-Path $OutputDir "FOR-UBUNTU-SERVER"
[void](New-Item -ItemType Directory -Path $ubuntuDir -Force)

Copy-Item -LiteralPath (Join-Path $ScriptDir "site.ubuntu.conf.example") -Destination (Join-Path $ubuntuDir "site.ubuntu.conf") -Force
Copy-Item -LiteralPath "$adminKeyPath.pub" -Destination (Join-Path $ubuntuDir "admin_authorized_keys") -Force
Write-OK "已复制 Ubuntu 配置模板，请编辑 $(Join-Path $ubuntuDir 'site.ubuntu.conf') 填入真实公网地址和接口名"

$adminPubKeyContent = Get-Content -LiteralPath "$adminKeyPath.pub" -Raw

# ── Windows 跳板配置 ──────────────────────────────────────────
Write-Step "准备 Windows 跳板部署材料"

$winDir = Join-Path $OutputDir "FOR-WINDOWS-BASTION"
[void](New-Item -ItemType Directory -Path $winDir -Force)

if ($python3) {
    $pythonScript = @'
import json, sys, pathlib
template_path = pathlib.Path(sys.argv[1])
output_path = pathlib.Path(sys.argv[2])
admin_pub = sys.argv[3].strip()
bootstrap_dir = pathlib.Path(sys.argv[4])

site = json.loads(template_path.read_text())
site.setdefault('_comment', {})
site['_comment']['adminPublicKey'] = admin_pub
site['_comment']['bootstrapPublicKey'] = str(bootstrap_dir / 'bootstrap_ed25519.pub')
site['_comment']['bootstrapPrivateKeyForWindows'] = str(bootstrap_dir / 'bootstrap_ed25519')
output_path.write_text(json.dumps(site, indent=2, ensure_ascii=False) + '\n')
'@
    $pythonScript | & $python3.Source - (Join-Path $ScriptDir "site.windows.json.example") (Join-Path $winDir "site.windows.json") $adminPubKeyContent $bootstrapKeyDir
    if ($LASTEXITCODE -ne 0) { throw "failed to populate site.windows.json" }
} else {
    Copy-Item -LiteralPath (Join-Path $ScriptDir "site.windows.json.example") -Destination (Join-Path $winDir "site.windows.json") -Force
    Write-Warn "site.windows.json 已直接复制；_comment 中的公钥和 bootstrap 路径提示未自动填写，请手动核对"
}

@'
# 在 Ubuntu 控制台执行：
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# 记下指纹，然后在 Windows 上通过 LAN 执行：
#   ssh-keyscan -t ed25519 10.203.10.10 >> known_hosts
# 比对指纹一致后覆盖此文件
'@ | Set-Content -LiteralPath (Join-Path $winDir "known_hosts") -Encoding ascii
Write-OK "已复制 Windows 配置模板，请编辑 $(Join-Path $winDir 'site.windows.json') 填入真实地址和接口名"

# ── README ─────────────────────────────────────────────────────
Write-Step "生成 USB 说明文件"

$genTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$templatePath = Join-Path $ScriptDir "usb-readme.template.txt"
$readme = Get-Content -LiteralPath $templatePath -Raw
$readme = $readme.Replace("{{GENERATED_AT_UTC}}", $genTime)
$readme = $readme.Replace("{{ADMIN_PRIVATE_KEY_PATH}}", $adminKeyPath)
if ($readme -match '\{\{|\}\}') { throw "unresolved placeholder in USB README template" }
$readme | Set-Content -LiteralPath (Join-Path $OutputDir "README.txt") -Encoding UTF8

# ── 最终输出 ──────────────────────────────────────────────────
Write-Step "准备完成"

Write-Host ""
Write-Host "  USB 目录：$OutputDir"
Write-Host "  Admin 私钥（不在 USB 中）：$adminKeyPath"
Write-Host ""
Write-Host "  目录结构："
Get-ChildItem -LiteralPath $OutputDir -Recurse -File | ForEach-Object { "    " + $_.FullName.Replace($OutputDir, "") }
Write-Host ""
Write-Host "  管理员 SSH 公钥指纹："
& $sshKeygen.Source -lf "$adminKeyPath.pub"
Write-Host ""
Write-Host "  Bootstrap SSH 公钥指纹："
& $sshKeygen.Source -lf "$bootstrapKeyPath.pub"
Write-Host ""
Write-Host "  ═══════════════════════════════════════════════════"
Write-Host "  下一步："
Write-Host "  1. 编辑对应拓扑的 site.*.conf/json，填入真实 IP 和接口名"
Write-Host "  2. 把整个 $OutputDir 目录拷到 U 盘"
Write-Host "  3. 把 apps/safety/ 目录也拷到 U 盘（或直接 clone 仓库到场）"
Write-Host "  4. 到场后按 README.txt 操作"
Write-Host "  ═══════════════════════════════════════════════════"
