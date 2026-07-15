#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-$HOME/CZ-Safety-USB}"
ADMIN_KEY_NAME="admin_ed25519"
BOOTSTRAP_KEY_NAME="bootstrap_ed25519"

info()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
step()  { printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$*"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────
step "检查本机工具"

command -v ssh-keygen >/dev/null 2>&1 || err "需要 ssh-keygen（Ubuntu 自带，如缺失: sudo apt install openssh-client）"
command -v python3   >/dev/null 2>&1 || err "需要 python3（Ubuntu 自带）"

if command -v wg >/dev/null 2>&1; then
  info "WireGuard 已安装（$(wg --version 2>/dev/null || echo ok)）"
else
  warn "WireGuard 未安装；部署完成后需要用 wireguard-tools 导入 peer 配置。"
  warn "  安装命令：sudo apt install wireguard-tools"
fi

if [ -d "$OUTPUT_DIR" ]; then
  warn "$OUTPUT_DIR 已存在，将在 5 秒后覆盖"
  sleep 5
fi
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ── SSH 密钥生成 ──────────────────────────────────────────────
step "生成 SSH 密钥"

ADMIN_KEY_DIR="$OUTPUT_DIR/FOR-MY-MACHINE"
mkdir -p "$ADMIN_KEY_DIR"
chmod 0700 "$ADMIN_KEY_DIR"

if [ -f "$HOME/.ssh/$ADMIN_KEY_NAME" ]; then
  info "复用已有 Admin SSH 密钥：~/.ssh/$ADMIN_KEY_NAME"
  cp "$HOME/.ssh/$ADMIN_KEY_NAME"     "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME"
  cp "$HOME/.ssh/$ADMIN_KEY_NAME.pub" "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME.pub"
else
  ssh-keygen -t ed25519 -f "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME" -N "" -C "admin@cz-safety-$(date +%Y%m%d)"
  info "已生成 Admin SSH 密钥对"
fi
chmod 0600 "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME"
chmod 0644 "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME.pub"

BOOTSTRAP_KEY_DIR="$OUTPUT_DIR/FOR-WINDOWS-BASTION"
mkdir -p "$BOOTSTRAP_KEY_DIR"
ssh-keygen -t ed25519 -f "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME" -N "" -C "bootstrap@cz-safety-$(date +%Y%m%d)"
chmod 0600 "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME"
chmod 0644 "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME.pub"
info "已生成 Bootstrap SSH 密钥对（仅 Windows 跳板拓扑使用）"

# ── Ubuntu 直连服务器配置 ─────────────────────────────────────
step "准备 Ubuntu 直连部署材料"

UBUNTU_DIR="$OUTPUT_DIR/FOR-UBUNTU-SERVER"
mkdir -p "$UBUNTU_DIR"

cp "$SCRIPT_DIR/site.ubuntu.conf.example" "$UBUNTU_DIR/site.ubuntu.conf"
cp "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME.pub"   "$UBUNTU_DIR/admin_authorized_keys"
info "已复制 Ubuntu 配置模板，请编辑 $UBUNTU_DIR/site.ubuntu.conf 填入真实公网地址和接口名"

ADMIN_PUB_KEY_CONTENT="$(cat "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME.pub")"

# ── Windows 跳板配置 ──────────────────────────────────────────
step "准备 Windows 跳板部署材料"

WIN_DIR="$OUTPUT_DIR/FOR-WINDOWS-BASTION"
mkdir -p "$WIN_DIR"

python3 - "$SCRIPT_DIR/site.windows.json.example" "$WIN_DIR/site.windows.json" "$ADMIN_PUB_KEY_CONTENT" "$BOOTSTRAP_KEY_DIR" <<'PY'
import json, sys, pathlib

template_path = pathlib.Path(sys.argv[1])
output_path   = pathlib.Path(sys.argv[2])
admin_pub     = sys.argv[3]
bootstrap_dir = pathlib.Path(sys.argv[4])

site = json.loads(template_path.read_text())
site.setdefault("_comment", {})
site["_comment"]["adminPublicKey"] = admin_pub
site["_comment"]["bootstrapPublicKey"] = str(bootstrap_dir / "bootstrap_ed25519.pub")
site["_comment"]["bootstrapPrivateKeyForWindows"] = str(bootstrap_dir / "bootstrap_ed25519")

output_path.write_text(json.dumps(site, indent=2, ensure_ascii=False) + "\n")
PY

cat > "$WIN_DIR/known_hosts" <<'EOF'
# 在 Ubuntu 控制台执行：
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# 记下指纹，然后在 Windows 上通过 LAN 执行：
#   ssh-keyscan -t ed25519 10.203.10.10 >> known_hosts
# 比对指纹一致后覆盖此文件
EOF
info "已复制 Windows 配置模板，请编辑 $WIN_DIR/site.windows.json 填入真实地址和接口名"

# ── README ─────────────────────────────────────────────────────
step "生成 USB 说明文件"

cat > "$OUTPUT_DIR/README.txt" <<'README_EOF'
═══════════════════════════════════════════════════════════════════
  CZ Safety 现场部署 USB 包
  生成时间：GENERATED_AT
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
   • 物理网卡名称（ip link 查看）
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
  8. 在你的电脑上：sudo cp onsite-admin.conf /etc/wireguard/wg0.conf && sudo wg-quick up wg0
  9. ssh -i admin_ed25519 safetyops@10.203.0.1（核对主机指纹！）
  10. sudo ... confirm --confirm-external

Windows 跳板：
  1. Ubuntu 控制台：创建 safety-bootstrap 用户、导入公钥、配置免交互 sudo
     sudo useradd --create-home --shell /bin/bash safety-bootstrap
     sudo mkdir -p ~safety-bootstrap/.ssh
     sudo cp bootstrap_ed25519.pub ~safety-bootstrap/.ssh/authorized_keys
     sudo chown -R safety-bootstrap:safety-bootstrap ~safety-bootstrap/.ssh
     sudo chmod 0700 ~safety-bootstrap/.ssh
     sudo chmod 0600 ~safety-bootstrap/.ssh/authorized_keys
     echo 'safety-bootstrap ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/safety-bootstrap
  2. Windows：把 bootstrap_ed25519 放到配置指定的路径
  3. Windows：从 LAN 侧核验 Ubuntu 主机指纹并填写 known_hosts
  4. PowerShell：.\deploy-windows-bastion.ps1 -Action Preflight -Config site.windows.json
  5. 依次 Plan → Apply -ConfirmConsole → PeerAdd → 外部测试 → Confirm -ConfirmExternal

⚠ 重要提醒
  • 私钥绝不提交到仓库
  • 部署前拔掉公网线，先完成 Ubuntu 基线恢复
  • 20 分钟自动回滚，请在窗口内完成外部测试
  • 工控机 BMC 默认不向公网开放
README_EOF

GEN_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
# portable in-place sed (BSD & GNU)
sed -i.bak "s/GENERATED_AT/$GEN_TIME/" "$OUTPUT_DIR/README.txt" && rm -f "$OUTPUT_DIR/README.txt.bak"

# ── 最终输出 ──────────────────────────────────────────────────
step "准备完成"

echo ""
echo "  USB 目录：$OUTPUT_DIR"
echo ""
echo "  目录结构："
find "$OUTPUT_DIR" -type f | sed "s|$OUTPUT_DIR/|    |" | sort
echo ""
echo "  管理员 SSH 公钥指纹："
ssh-keygen -lf "$ADMIN_KEY_DIR/$ADMIN_KEY_NAME.pub"
echo ""
echo "  Bootstrap SSH 公钥指纹："
ssh-keygen -lf "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME.pub"
echo ""
echo "  ═══════════════════════════════════════════════════"
echo "  下一步："
echo "  1. 编辑对应拓扑的 site.*.conf/json，填入真实 IP 和接口名"
echo "  2. 把整个 $OUTPUT_DIR 目录拷到 U 盘"
echo "  3. 把 apps/safety/ 目录也拷到 U 盘（或直接 clone 仓库到场）"
echo "  4. 到场后按 README.txt 操作"
echo "  ═══════════════════════════════════════════════════"
