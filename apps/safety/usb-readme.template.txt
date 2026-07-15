═══════════════════════════════════════════════════════════════════
  CZ Safety 现场部署 USB 包
  生成时间：{{GENERATED_AT_UTC}}
═══════════════════════════════════════════════════════════════════

管理员 SSH 私钥不在本 USB 包内，固定留在准备材料的电脑：
  {{ADMIN_PRIVATE_KEY_PATH}}

不要把该私钥复制到 U 盘、服务器、Windows 跳板机或云同步目录。
USB/exFAT/FAT 上的 chmod 不能作为权限边界。

本 U 盘包含两个目录：

  FOR-UBUNTU-SERVER/      用于“Ubuntu 直接接公网”拓扑
  ├── site.ubuntu.conf    现场配置（先编辑真实 IP！）
  └── admin_authorized_keys  管理员公钥

  FOR-WINDOWS-BASTION/    用于“Windows 跳板”拓扑
  ├── site.windows.json   现场配置（先编辑真实 IP！）
  ├── bootstrap_ed25519   Ubuntu 初始化私钥（只临时放到 Windows）
  ├── bootstrap_ed25519.pub Ubuntu 初始化公钥（放到 Ubuntu）
  └── known_hosts         主机指纹（到场核验后填写）

── 部署前必须做的事 ──────────────────────────────────────────

1. 编辑对应拓扑的配置文件，把 example 地址换成 IDC 分配的真实地址：
   • 公网 /30 地址（当前现场为 .105 网关 / .106 本方）
   • 物理网卡名称（Windows: Get-NetAdapter；Ubuntu/macOS: ip link/ifconfig）
   • 其他按需调整

2. 如果是 Windows 跳板拓扑，提前在 Windows 上安装：
   • WireGuard for Windows（https://www.wireguard.com/install/）
   • 安装后在配置中填写正确的 wireguardExe / wgExe 路径

3. Windows 准备脚本找不到 Python 时会直接复制 site.windows.json 模板，
   不会自动填写 _comment 中的公钥和 bootstrap 路径提示；脚本会告警，
   现场运维必须手动核对这些路径。

   Windows 脚本生成密钥后会用空口令重新加载验证；若目标 OpenSSH
   不接受空字符串参数，脚本会终止。请保存 ssh -V 和脚本输出。

4. 如果现场没有互联网，提前在一台全新 Ubuntu 24.04 上运行：
   sudo ./deploy-ubuntu-direct.sh prepare-bundle --config site.ubuntu.conf --output-dir offline-debs
   把生成的 offline-debs/ 目录一起放到 U 盘。

── 到场后的执行顺序 ──────────────────────────────────────────

Ubuntu 直连：
  1. Ubuntu 控制台：sudo install -d -m 0700 /root/cz-safety
  2. 插入 U 盘，sudo install -m 0600 .../admin_authorized_keys /root/cz-safety/
  3. sudo ./deploy-ubuntu-direct.sh preflight --config site.ubuntu.conf
  4. sudo ./deploy-ubuntu-direct.sh plan     --config site.ubuntu.conf | less
  5. sudo ./deploy-ubuntu-direct.sh apply    --config site.ubuntu.conf --confirm-console
  6. sudo /usr/local/sbin/deploy-ubuntu-direct.sh peer-add --config /etc/cz-safety/site.conf --name onsite-admin --role admin
  7. 把 .../exports/onsite-admin.conf 拷回加密 U 盘
  8. 在管理员电脑导入 WireGuard 配置，再从外部网络测试
  9. ssh -i "{{ADMIN_PRIVATE_KEY_PATH}}" safetyops@10.203.0.1（核对主机指纹）
  10. sudo /usr/local/sbin/deploy-ubuntu-direct.sh confirm --config /etc/cz-safety/site.conf --confirm-external

Windows 跳板：
  1. Ubuntu 控制台创建临时 bootstrap 身份：
     sudo useradd --create-home --shell /bin/bash safety-bootstrap
     sudo install -d -m 0700 -o safety-bootstrap -g safety-bootstrap ~safety-bootstrap/.ssh
     sudo install -m 0600 -o safety-bootstrap -g safety-bootstrap bootstrap_ed25519.pub ~safety-bootstrap/.ssh/authorized_keys
     echo 'safety-bootstrap ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/safety-bootstrap
     sudo chmod 0440 /etc/sudoers.d/safety-bootstrap
  2. Windows：把 bootstrap_ed25519 放到配置指定的 ACL 受限路径
  3. Windows：从 LAN 侧核验 Ubuntu 主机指纹并填写 known_hosts
  4. PowerShell：.\deploy-windows-bastion.ps1 -Action Preflight -Config site.windows.json
  5. 依次 Plan → Apply -ConfirmConsole → PeerAdd → 外部测试 → Confirm -ConfirmExternal
  6. Confirm 后删除 Windows 和 U 盘上的 bootstrap 私钥，并按变更单移除临时 bootstrap 身份

⚠ 重要提醒
  • 管理员私钥只留在 {{ADMIN_PRIVATE_KEY_PATH}}
  • Bootstrap 私钥同样敏感，优先使用加密 U 盘并在部署后清除
  • 私钥绝不提交到仓库
  • 部署前拔掉公网线，先完成 Ubuntu 基线恢复
  • 20 分钟自动回滚，请在窗口内完成外部测试
  • BMC 默认不向公网开放
