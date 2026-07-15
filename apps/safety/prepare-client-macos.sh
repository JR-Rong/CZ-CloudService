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

normalize_output_dir() {
  python3 - "$1" "$HOME" <<'PY'
from pathlib import Path
import sys

output = Path(sys.argv[1]).expanduser().resolve(strict=False)
dangerous = {Path("/"), Path(sys.argv[2]).expanduser().resolve(), Path.cwd().resolve()}
if output in dangerous:
    raise SystemExit(f"refusing dangerous output directory: {output}")
print(output)
PY
}

# ── Prerequisites ──────────────────────────────────────────────
step "检查本机工具"

command -v ssh-keygen >/dev/null 2>&1 || err "需要 ssh-keygen（macOS 自带，如缺失请安装 Xcode Command Line Tools: xcode-select --install）"
command -v python3   >/dev/null 2>&1 || err "需要 python3（macOS 自带）"

if command -v wg >/dev/null 2>&1; then
  info "WireGuard 已安装（$(wg --version 2>/dev/null || echo ok)）"
else
  warn "WireGuard 未安装；部署完成后需要用它导入 peer 配置。App Store 搜索 WireGuard 安装即可。"
fi

if ! OUTPUT_DIR="$(normalize_output_dir "$OUTPUT_DIR")"; then
  err "输出目录不安全"
fi
[ ! -e "$OUTPUT_DIR" ] || err "$OUTPUT_DIR 已存在；脚本不会覆盖或删除现有目录，请换一个新目录"
mkdir -p "$OUTPUT_DIR"

# ── SSH 密钥生成 ──────────────────────────────────────────────
step "生成 SSH 密钥"

# Admin 密钥（用于 VPN 隧道内 SSH 登录服务器）
ADMIN_KEY_DIR="$HOME/.ssh"
mkdir -p "$ADMIN_KEY_DIR"
chmod 0700 "$ADMIN_KEY_DIR"
ADMIN_KEY_PATH="$ADMIN_KEY_DIR/$ADMIN_KEY_NAME"

if [ -f "$ADMIN_KEY_PATH" ]; then
  [ -f "$ADMIN_KEY_PATH.pub" ] || err "已有 Admin 私钥缺少公钥文件：$ADMIN_KEY_PATH.pub"
  info "复用已有 Admin SSH 密钥：$ADMIN_KEY_PATH"
else
  [ ! -e "$ADMIN_KEY_PATH" ] || err "Admin 密钥路径不是普通文件：$ADMIN_KEY_PATH"
  ssh-keygen -q -t ed25519 -f "$ADMIN_KEY_PATH" -N "" -C "admin@cz-safety-$(date -u +%Y%m%d)"
  ssh-keygen -y -P "" -f "$ADMIN_KEY_PATH" >/dev/null || err "新 Admin 私钥无法用空口令加载"
  info "已在本机生成 Admin SSH 密钥对（不会写入 USB 目录或 Desktop）"
fi
chmod 0600 "$ADMIN_KEY_PATH"
chmod 0644 "$ADMIN_KEY_PATH.pub"
ssh-keygen -lf "$ADMIN_KEY_PATH.pub" | grep -q 'ED25519' || err "Admin 密钥必须是 Ed25519：$ADMIN_KEY_PATH"

# Bootstrap 密钥（仅 Windows 跳板拓扑需要——Windows 用此密钥在 LAN 侧初始化 Ubuntu）
BOOTSTRAP_KEY_DIR="$OUTPUT_DIR/FOR-WINDOWS-BASTION"
mkdir -p "$BOOTSTRAP_KEY_DIR"
ssh-keygen -q -t ed25519 -f "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME" -N "" -C "bootstrap@cz-safety-$(date -u +%Y%m%d)"
ssh-keygen -y -P "" -f "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME" >/dev/null || err "Bootstrap 私钥无法用空口令加载"
chmod 0600 "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME"
chmod 0644 "$BOOTSTRAP_KEY_DIR/$BOOTSTRAP_KEY_NAME.pub"
info "已生成 Bootstrap SSH 密钥对（仅 Windows 跳板拓扑使用）"

# ── Ubuntu 直连服务器配置 ─────────────────────────────────────
step "准备 Ubuntu 直连部署材料"

UBUNTU_DIR="$OUTPUT_DIR/FOR-UBUNTU-SERVER"
mkdir -p "$UBUNTU_DIR"

cp "$SCRIPT_DIR/site.ubuntu.conf.example" "$UBUNTU_DIR/site.ubuntu.conf"
cp "$ADMIN_KEY_PATH.pub" "$UBUNTU_DIR/admin_authorized_keys"
info "已复制 Ubuntu 配置模板，请编辑 $UBUNTU_DIR/site.ubuntu.conf 填入真实公网地址和接口名"

ADMIN_PUB_KEY_CONTENT="$(< "$ADMIN_KEY_PATH.pub")"

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

# Fill in the public-key commentary so the operator knows what key goes where
site.setdefault("_comment", {})
site["_comment"]["adminPublicKey"] = admin_pub
site["_comment"]["bootstrapPublicKey"] = str(bootstrap_dir / "bootstrap_ed25519.pub")
site["_comment"]["bootstrapPrivateKeyForWindows"] = str(bootstrap_dir / "bootstrap_ed25519")

output_path.write_text(json.dumps(site, indent=2, ensure_ascii=False) + "\n")
PY

# known_hosts 占位文件
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

python3 - "$SCRIPT_DIR/usb-readme.template.txt" "$OUTPUT_DIR/README.txt" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$ADMIN_KEY_PATH" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
content = template_path.read_text(encoding="utf-8")
content = content.replace("{{GENERATED_AT_UTC}}", sys.argv[3])
content = content.replace("{{ADMIN_PRIVATE_KEY_PATH}}", sys.argv[4])
if "{{" in content or "}}" in content:
    raise SystemExit("unresolved placeholder in USB README template")
output_path.write_text(content, encoding="utf-8")
PY

# ── 最终输出 ──────────────────────────────────────────────────
step "准备完成"

echo ""
echo "  USB 目录：$OUTPUT_DIR"
echo "  Admin 私钥（不在 USB 中）：$ADMIN_KEY_PATH"
echo ""
echo "  目录结构："
find "$OUTPUT_DIR" -type f | sed "s|$OUTPUT_DIR/|    |" | sort
echo ""
echo "  管理员 SSH 公钥指纹："
ssh-keygen -lf "$ADMIN_KEY_PATH.pub"
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
