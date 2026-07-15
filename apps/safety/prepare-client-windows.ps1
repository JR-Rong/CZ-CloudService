[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $OutputDir) { $OutputDir = Join-Path $env:USERPROFILE "Desktop\CZ-Safety-USB" }

function Write-Step { param([string]$Message); Write-Host "`n$([char]0x2501)$([char]0x2501) $Message $([char]0x2501)$([char]0x2501)" -ForegroundColor Cyan }
function Write-OK   { param([string]$Message); Write-Host "$([char]0x2713) $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message); Write-Host "$([char]0x26A0) $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message); Write-Host "$([char]0x2717) $Message" -ForegroundColor Red; exit 1 }

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

if (Test-Path -LiteralPath $OutputDir) {
    Write-Warn "$OutputDir 已存在，将在 5 秒后覆盖"
    Start-Sleep -Seconds 5
}
Remove-Item -LiteralPath $OutputDir -Recurse -Force -ErrorAction SilentlyContinue
[void](New-Item -ItemType Directory -Path $OutputDir -Force)

# ── SSH 密钥生成 ──────────────────────────────────────────────
Write-Step "生成 SSH 密钥"

$adminKeyName = "admin_ed25519"
$bootstrapKeyName = "bootstrap_ed25519"

$adminKeyDir = Join-Path $OutputDir "FOR-MY-MACHINE"
[void](New-Item -ItemType Directory -Path $adminKeyDir -Force)

$adminKeyPath = Join-Path $adminKeyDir $adminKeyName
$userSshDir = Join-Path $env:USERPROFILE ".ssh"
$userSshKey = Join-Path $userSshDir $adminKeyName

if (Test-Path -LiteralPath $userSshKey) {
    Write-OK "复用已有 Admin SSH 密钥：$userSshKey"
    Copy-Item -LiteralPath $userSshKey          -Destination (Join-Path $adminKeyDir $adminKeyName) -Force
    Copy-Item -LiteralPath "$userSshKey.pub"    -Destination (Join-Path $adminKeyDir "$adminKeyName.pub") -Force
} else {
    & ssh-keygen.exe -t ed25519 -f $adminKeyPath -N '""' -C "admin@cz-safety-$(Get-Date -Format yyyyMMdd)"
    Write-OK "已生成 Admin SSH 密钥对"
}

$bootstrapKeyDir = Join-Path $OutputDir "FOR-WINDOWS-BASTION"
[void](New-Item -ItemType Directory -Path $bootstrapKeyDir -Force)
$bootstrapKeyPath = Join-Path $bootstrapKeyDir $bootstrapKeyName
& ssh-keygen.exe -t ed25519 -f $bootstrapKeyPath -N '""' -C "bootstrap@cz-safety-$(Get-Date -Format yyyyMMdd)"
Write-OK "已生成 Bootstrap SSH 密钥对（仅 Windows 跳板拓扑使用）"

# ── Ubuntu 直连服务器配置 ─────────────────────────────────────
Write-Step "准备 Ubuntu 直连部署材料"

$ubuntuDir = Join-Path $OutputDir "FOR-UBUNTU-SERVER"
[void](New-Item -ItemType Directory -Path $ubuntuDir -Force)

Copy-Item -LiteralPath (Join-Path $ScriptDir "site.ubuntu.conf.example") -Destination (Join-Path $ubuntuDir "site.ubuntu.conf") -Force
Copy-Item -LiteralPath (Join-Path $adminKeyDir "$adminKeyName.pub")      -Destination (Join-Path $ubuntuDir "admin_authorized_keys") -Force
Write-OK "已复制 Ubuntu 配置模板，请编辑 $(Join-Path $ubuntuDir 'site.ubuntu.conf') 填入真实公网地址和接口名"

$adminPubKeyContent = Get-Content -LiteralPath (Join-Path $adminKeyDir "$adminKeyName.pub") -Raw

# ── Windows 跳板配置 ──────────────────────────────────────────
Write-Step "准备 Windows 跳板部署材料"

$winDir = Join-Path $OutputDir "FOR-WINDOWS-BASTION"
[void](New-Item -ItemType Directory -Path $winDir -Force)

if ($python3) {
    $pythonScript = @"
import json, sys, pathlib
template_path = pathlib.Path(r'$(Join-Path $ScriptDir "site.windows.json.example")')
output_path   = pathlib.Path(r'$(Join-Path $winDir "site.windows.json")')
admin_pub     = r'''$adminPubKeyContent'''.strip()
bootstrap_dir = pathlib.Path(r'$bootstrapKeyDir')

site = json.loads(template_path.read_text())
site.setdefault('_comment', {})
site['_comment']['adminPublicKey'] = admin_pub
site['_comment']['bootstrapPublicKey'] = str(bootstrap_dir / 'bootstrap_ed25519.pub')
site['_comment']['bootstrapPrivateKeyForWindows'] = str(bootstrap_dir / 'bootstrap_ed25519')
output_path.write_text(json.dumps(site, indent=2, ensure_ascii=False) + '\n')
"@
    $pythonScript | & $python3.Source -
} else {
    Copy-Item -LiteralPath (Join-Path $ScriptDir "site.windows.json.example") -Destination (Join-Path $winDir "site.windows.json") -Force
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

@"
═══════════════════════════════════════════════════════════════════
  CZ Safety 现场部署 USB 包
  生成时间：$genTime
═══════════════════════════════════════════════════════════════════

本 U 盘包含三个目录：

  FOR-MY-MACHINE/        留在你的电脑上，不要带到服务器
  ├── admin_ed25519       管理员 SSH 私钥（绝不离手）
  └── admin_ed25519.pub   管理员 SSH 公钥

  FOR-UBUNTU-SERVER/      用于"Ubuntu 直接接公网"拓扑
  ├── site.ubuntu.conf    现场配置（先编辑真实 IP！）
  └── admin_authorized_keys  管理员公钥

  FOR-WINDOWS-BASTION/    用于"Windows 跳板"拓扑
  ├── site.windows.json   现场配置（先编辑真实 IP！）
  ├── bootstrap_ed25519   Ubuntu 初始化私钥（放到 Windows）
  ├── bootstrap_ed25519.pub Ubuntu 初始化公钥（放到 Ubuntu）
  └── known_hosts         主机指纹（到场核验后填写）

── 部署前必须做的事 ──────────────────────────────────────────

1. 编辑对应拓扑的配置文件，把 example 地址换成 IDC 分配的真实地址：
   • 公网 /30 地址（.105 网关 / .106 本方）
   • 物理网卡名称（Windows: Get-NetAdapter 查看；Ubuntu: ip link 查看）
   • 其他按需调整

2. 如果是 Windows 跳板拓扑，提前在 Windows 上安装：
   • WireGuard for Windows（https://www.wireguard.com/install/）
   • 安装后在配置中填写正确的 wireguardExe / wgExe 路径

3. 如果现场没有互联网，提前在一台 全新 Ubuntu 24.04 上运行：
   sudo ./deploy-ubuntu-direct.sh prepare-bundle --config site.ubuntu.conf --output-dir offline-debs
   把生成的 offline-debs/ 目录一起放到 U 盘。

── 到场后的执行顺序 ──────────────────────────────────────────

Ubuntu 直连：
  1. Ubuntu 控制台：sudo install -d -m 0700 /root/cz-safety
  2. 插入 U 盘，sudo install -m 0600 .../admin_authorized_keys /root/cz-safety/
  3. sudo ./deploy-ubuntu-direct.sh preflight --config site.ubuntu.conf
  4. sudo ./deploy-ubuntu-direct.sh plan     --config site.ubuntu.conf | less
  5. sudo ./deploy-ubuntu-direct.sh apply    --config site.ubuntu.conf --confirm-console
  6. sudo /usr/local/sbin/deploy-ubuntu-direct.sh peer-add --name onsite-admin --role admin
  7. 把 .../exports/onsite-admin.conf 拷回 U 盘
  8. 在你的电脑上导入 WireGuard 配置，从外部测试
  9. sudo ... confirm --confirm-external

Windows 跳板：
  1. Ubuntu 控制台：创建 safety-bootstrap 用户、导入公钥、配置免交互 sudo
     （详见 apps/safety/README.md）
  2. Windows：把 bootstrap_ed25519 放到配置指定的路径
  3. Windows：从 LAN 侧核验 Ubuntu 主机指纹并填写 known_hosts
  4. PowerShell：.\deploy-windows-bastion.ps1 -Action Preflight -Config site.windows.json
  5. 依次 Plan → Apply -ConfirmConsole → PeerAdd → 外部测试 → Confirm -ConfirmExternal

⚠ 重要提醒
  • 私钥绝不提交到仓库
  • 部署前拔掉公网线，先完成 Ubuntu 基线恢复
  • 20 分钟自动回滚，请在窗口内完成外部测试
  • 工控机 BMC 默认不向公网开放
"@ | Set-Content -LiteralPath (Join-Path $OutputDir "README.txt") -Encoding UTF8

# ── 最终输出 ──────────────────────────────────────────────────
Write-Step "准备完成"

Write-Host ""
Write-Host "  USB 目录：$OutputDir"
Write-Host ""
Write-Host "  目录结构："
Get-ChildItem -LiteralPath $OutputDir -Recurse -File | ForEach-Object { "    " + $_.FullName.Replace($OutputDir, "") }
Write-Host ""
Write-Host "  管理员 SSH 公钥指纹："
& ssh-keygen.exe -lf (Join-Path $adminKeyDir "$adminKeyName.pub")
Write-Host ""
Write-Host "  Bootstrap SSH 公钥指纹："
& ssh-keygen.exe -lf (Join-Path $bootstrapKeyDir "$bootstrapKeyName.pub")
Write-Host ""
Write-Host "  ═══════════════════════════════════════════════════"
Write-Host "  下一步："
Write-Host "  1. 编辑对应拓扑的 site.*.conf/json，填入真实 IP 和接口名"
Write-Host "  2. 把整个 $OutputDir 目录拷到 U 盘"
Write-Host "  3. 把 apps/safety/ 目录也拷到 U 盘（或直接 clone 仓库到场）"
Write-Host "  4. 到场后按 README.txt 操作"
Write-Host "  ═══════════════════════════════════════════════════"
