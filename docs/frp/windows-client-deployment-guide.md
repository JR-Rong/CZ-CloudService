# Windows 客户端通过 frp 暴露 SSH 到公网教程

目标：让 Windows 客户端通过 frpc 连接公网 frps，并把 Windows 本机 SSH 暴露为：

```bash
ssh -p 2222 admin@60.205.213.254
```

本教程基于这次实际排障整理，重点覆盖我们踩过的坑。

## 1. 架构

公网 ECS：

- 公网 IP：`60.205.213.254`
- frps 控制端口：`7000`
- 对外 SSH 代理端口：`2222`

Windows 客户端：

- 本地 OpenSSH Server 监听：`127.0.0.1:22222`
- 内网 Qwen3.6 LLM 服务：`192.168.100.12:8000`
- 内网 AI Chat Web 服务：`192.168.100.12:9999`
- frpc 连接 ECS：`60.205.213.254:7000`
- frpc 转发规则：`remotePort 2222 -> localPort 22222`
- frpc 转发规则：`remotePort 9000 -> 192.168.100.12:8000`
- frpc 转发规则：`remotePort 9999 -> 192.168.100.12:9999`

最终访问路径：

```text
Mac/外部机器
  -> 60.205.213.254:2222
  -> ECS frps
  -> Windows frpc
  -> Windows 127.0.0.1:22222 sshd
  -> Windows 用户 admin
```

## 2. 先确认 ECS frps 已 ready

在本机或任意能 SSH 到 ECS 的机器执行：

```bash
ssh root@60.205.213.254 'systemctl is-enabled frps; systemctl is-active frps; /usr/local/bin/frps --version; ss -tlnp | grep -E "(:7000|:2222)([[:space:]]|$)" || true'
```

期望：

```text
enabled
active
0.69.1
*:7000  frps
```

注意：`*:2222` 只有在 Windows `frpc` 成功连接并注册代理后才会出现。只看到 `*:7000` 是正常的，表示 frps 在等客户端。

服务端 `/etc/frp/frps.toml` 核心配置应类似：

```toml
bindPort = 7000

auth.method = "token"
auth.token = "<不要写进文档或聊天>"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.force = true
transport.tcpMux = false

allowPorts = [
  { start = 2222, end = 2222 },
  { start = 2444, end = 2444 },
  { start = 9000, end = 9000 },
  { start = 9999, end = 9999 }
]
```

如果要第二台机器同时接入，不能也用 `2222`，需要新增如 `2223`，并在 `allowPorts` 和阿里云安全组里放行。

## 3. Windows 安装并修好 OpenSSH Server

管理员 PowerShell 执行：

```powershell
$ErrorActionPreference = "Stop"

$cap = Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
if ($cap.State -ne "Installed") {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
}

$sshDir = "$env:ProgramData\ssh"
$cfg = "$sshDir\sshd_config"
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null

& "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -A

@(
  "Port 22222"
  "ListenAddress 127.0.0.1"
  "Subsystem sftp sftp-server.exe"
) | Set-Content -Encoding ascii $cfg

& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t -f $cfg
```

如果 Windows 自带 OpenSSH 是 `OpenSSH_9.5p2 for Windows`，并且 `Start-Service sshd` 一直失败或出现 `Event ID 7034` / `WIN32_EXIT_CODE 1067`，建议升级到 Win32-OpenSSH 官方新版。

### 3.1 升级 OpenSSH 的可靠方式

我们这次遇到 Windows/ECS 直接拉 GitHub 失败，所以最终使用“先下载完整 ZIP，再校验”的方式。通用步骤如下。

下载官方 `OpenSSH-Win64.zip` 后，必须确认里面包含：

```text
sshd.exe
install-sshd.ps1
FixHostFilePermissions.ps1
OpenSSHUtils.psm1
openssh-events.man
```

然后管理员 PowerShell 执行：

```powershell
$ErrorActionPreference = "Stop"

$zip = "$env:TEMP\OpenSSH-Win64.zip"
$tmp = "$env:TEMP\openssh-win64-install"
$dst = "C:\Program Files\OpenSSH-Win64"

# 如果 ZIP 是从内部 HTTP/ECS 下载，先校验 SHA256；不要跳过校验。
# 示例：
# curl.exe -fL "http://60.205.213.254/OpenSSH-Win64.zip" -o $zip
# Get-FileHash $zip -Algorithm SHA256

Stop-Service sshd -ErrorAction SilentlyContinue
Stop-Service ssh-agent -ErrorAction SilentlyContinue
Get-Process sshd,ssh-agent -ErrorAction SilentlyContinue | Stop-Process -Force

sc.exe delete sshd 2>$null
sc.exe delete ssh-agent 2>$null
Start-Sleep 3

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp -Force

$src = Get-ChildItem $tmp -Directory |
  Where-Object { Test-Path "$($_.FullName)\install-sshd.ps1" } |
  Select-Object -First 1

if (!$src) { throw "解压后没有 install-sshd.ps1" }

if (Test-Path $dst) {
  Rename-Item $dst "$dst.bak.$(Get-Date -Format yyyyMMddHHmmss)"
}

Copy-Item $src.FullName $dst -Recurse -Force
cd $dst

.\ssh-keygen.exe -A
PowerShell.exe -ExecutionPolicy Bypass -File .\install-sshd.ps1

@(
  "Port 22222"
  "ListenAddress 127.0.0.1"
  "Subsystem sftp sftp-server.exe"
) | Set-Content -Encoding ascii "$env:ProgramData\ssh\sshd_config"

.\sshd.exe -t -f "$env:ProgramData\ssh\sshd_config"

Set-Service sshd -StartupType Automatic
Start-Service sshd

Get-Service sshd
Get-NetTCPConnection -LocalPort 22222
```

成功后，本机验证：

```powershell
ssh -p 22222 admin@127.0.0.1 hostname
```

能打印 hostname，说明 Windows OpenSSH 已经修好。

## 4. Windows 配置 frpc

目录建议：

```text
C:\Users\chuan\todesk-ssh
```

`frpc.toml`：

```toml
serverAddr = "60.205.213.254"
serverPort = 7000

auth.method = "token"
auth.token = "<填 ECS /etc/frp/frps.toml 里相同的 token>"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.enable = true
transport.tcpMux = false

log.to = "C:\\Users\\chuan\\todesk-ssh\\frpc.log"
log.level = "debug"
log.maxDays = 3

[[proxies]]
name = "ai-station-windows-ssh-2222"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22222
remotePort = 2222

[[proxies]]
name = "ai-llm-qwen36-9000"
type = "tcp"
localIP = "192.168.100.12"
localPort = 8000
remotePort = 9000

[[proxies]]
name = "ai-chat-web-9999"
type = "tcp"
localIP = "192.168.100.12"
localPort = 9999
remotePort = 9999
```

自动启动选项：

- `-CreateStartupShortcut`：在当前用户的 Startup 文件夹创建快捷方式。只有这个用户登录后才会启动 `frpc`。
- `-RegisterScheduledTask -ScheduledTaskTrigger AtLogon`：为当前用户创建任务计划程序登录触发器，方便用 `Get-ScheduledTask` 检查，不改变原来的快捷方式行为。
- `-RegisterScheduledTask -ScheduledTaskTrigger AtStartup`：创建 `SYSTEM` 启动触发器，需要管理员 PowerShell。这个模式建议把 `-InstallDir` 放到 `C:\ProgramData\CZ-CloudService\frpc` 这类 `SYSTEM` 可读目录。
- `-RestartExistingDetached`：通过当前 `2222` FRP SSH 会话更新 `frpc.toml` 时使用。它先写配置，再启动一个延迟后台重启脚本，避免当前 SSH 命令在停掉旧 `frpc` 后来不及启动新进程。

当前用户任务计划示例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<填 ECS /etc/frp/frps.toml 里相同的 token>" `
  -RegisterScheduledTask `
  -ScheduledTaskTrigger AtLogon
```

如果是通过 `ssh -p 2222 admin@60.205.213.254` 远程执行更新，使用 detached 重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<填 ECS /etc/frp/frps.toml 里相同的 token>" `
  -SkipLocalPortCheck `
  -CheckLlmPort `
  -RestartExistingDetached
```

检查任务：

```powershell
Get-ScheduledTask -TaskName "CZ CloudService frpc"
```

启动：

```powershell
cd C:\Users\chuan\todesk-ssh

Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force

.\frp_0.69.1_windows_amd64\frpc.exe -c .\frpc.toml
```

看到以下日志才算成功：

```text
login to server success
proxy added: [ai-station-windows-ssh-2222]
proxy added: [ai-llm-qwen36-9000]
start proxy success
```

此时 ECS 上应能看到：

```bash
ssh root@60.205.213.254 'ss -tlnp | grep -E "(:7000|:2222)([[:space:]]|$)"'
```

期望：

```text
*:7000  frps
*:2222  frps
```

## 5. 联调顺序

严格按这个顺序测，不要跳步。

### 5.1 Windows 本机测 sshd

```powershell
Test-NetConnection 127.0.0.1 -Port 22222
ssh -p 22222 admin@127.0.0.1 hostname
```

如果这里失败，先别看 frp。问题一定在 Windows OpenSSH。

### 5.2 ECS 测 frps 是否注册 2222

```bash
ssh root@60.205.213.254 'ss -tlnp | grep -E "(:7000|:2222)([[:space:]]|$)" || true; tail -n 80 /var/log/frps.log'
```

如果没有 `*:2222`，说明 Windows `frpc` 没运行、token 不匹配、TLS 配置不匹配，或 `frpc` 已退出。

### 5.3 公网测

```bash
ssh -p 2222 admin@60.205.213.254 hostname
```

成功时会打印 Windows hostname。

## 6. 这次实际踩过的坑

### 坑 1：公网 2222 能连上，但 SSH 直接断开

现象：

```text
Connection established.
kex_exchange_identification: Connection closed by remote host
```

原因通常不是用户名错，而是 frps 收到了连接，但 frpc 转发不到 Windows 本地 sshd。

看 Windows `frpc.log`，这次的关键错误是：

```text
connect to local service [127.0.0.1:22222] error: connectex: No connection could be made because the target machine actively refused it.
```

含义：Windows 本地没有进程监听 `127.0.0.1:22222`。

修复：先让 `ssh -p 22222 admin@127.0.0.1 hostname` 在 Windows 本机成功。

### 坑 2：Windows 只有 OpenSSH Client，没有 Server

现象：

```powershell
Get-Service sshd
```

返回找不到服务。

修复：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

### 坑 3：`sshd -ddd` 能跑，`Start-Service sshd` 失败

现象：

```text
OpenSSH_9.5p2 for Windows
Event ID 7034
WIN32_EXIT_CODE 1067
```

同时前台运行：

```powershell
sshd.exe -D -ddd -e -f C:\ProgramData\ssh\sshd_config
```

能监听 `127.0.0.1:22222`。

原因：Windows 自带 OpenSSH 9.5 服务化启动异常，常见于 OpenSSH 9.5 相关更新和 `C:\ProgramData\ssh` / `logs` ACL 问题。我们最终升级到 Win32-OpenSSH 新版解决。

### 坑 4：手动前台跑 sshd 后，密码正确仍然断开

现象：

```text
Authenticated to 127.0.0.1 using "password".
client_loop: send disconnect: Connection reset
```

服务端调试日志：

```text
Accepted password for admin
CreateProcessAsUserW failed error:1314
fork of unprivileged child failed
```

原因：手动 PowerShell 跑 `sshd -D -ddd` 不是以 `LocalSystem` 服务方式运行，认证后无法创建用户会话。

修复：不要用前台 debug 进程作为长期方案，必须让 `sshd` 服务正常运行。

### 坑 5：GitHub ZIP 下载失败后继续执行，导致状态更乱

现象：

```text
Invoke-WebRequest : 无法连接到远程服务器
Expand-Archive : 路径 ... OpenSSH-Win64.zip 不存在
install-sshd.ps1 不存在
```

原因：第一步下载失败，后续命令还继续执行。

修复：设置 `$ErrorActionPreference = "Stop"`，并且下载后做 SHA256 校验。失败就停止，不要继续安装。

### 坑 6：删掉 sshd 服务后，目录里没有 install 脚本

现象：

```text
sc.exe delete sshd 成功
install-sshd.ps1 不存在
Get-Service sshd 找不到服务
```

原因：MSI 安装目录 `C:\Program Files\OpenSSH` 可能没有 `install-sshd.ps1`。删掉服务后，如果没有脚本重建，服务就真的没了。

修复：用官方 ZIP 包，确保里面有 `install-sshd.ps1`，再运行脚本正式注册服务。

### 坑 7：Windows OpenSSH 修好后，公网仍提示 Connection closed

现象：

```text
ssh -p 2222 admin@60.205.213.254
Connection closed by 60.205.213.254 port 2222
```

ECS 上看不到 `*:2222`：

```bash
ss -tlnp | grep 2222
```

原因：修 OpenSSH 时杀进程或重启服务，把 `frpc` 也停掉了。frps 日志会看到：

```text
proxy closing
listener is closed: accept tcp [::]:2222
client exit success
```

修复：重新启动 Windows `frpc`。

### 坑 8：`2222` 同一时间只能给一台客户端用

如果两台 Windows 客户端都写：

```toml
remotePort = 2222
```

第二台会冲突。第二台应使用：

```toml
remotePort = 2223
```

同时服务端 `allowPorts`、阿里云安全组都要放行 `2223`。

## 7. 安全注意事项

### 阿里云“反弹 shell”告警

frp / 反向 SSH 的行为模型是：

```text
内网机器主动连公网服务器，再把内网服务暴露出来
```

这和攻击里的“反弹 shell”形态很像，所以阿里云可能告警。对我们这个用途来说可以是误报，但必须收紧安全边界。

建议：

1. 阿里云安全组不要长期把 `2222` 暴露给 `0.0.0.0/0`。
2. 只给你的当前公网 IP 放行，比如 `x.x.x.x/32`。
3. frps token 不要写进聊天、文档或公开 HTTP 目录。
4. 如果 token 曾经暴露，立刻轮换 ECS 和 Windows 两边的 token。
5. 不用的临时 HTTP 服务要关掉：

```bash
ssh root@60.205.213.254 'fuser -k 80/tcp'
```

6. 不再使用旧反向 SSH 方案时，删除 ECS `/root/.ssh/authorized_keys` 里旧的受限 key 标记行，例如 `codex-todesk-reverse-tunnel`。

## 8. 最终可用命令

Windows 端：

```powershell
Get-Service sshd
Get-NetTCPConnection -LocalPort 22222
ssh -p 22222 admin@127.0.0.1 hostname
Invoke-WebRequest http://192.168.100.12:8000/health -UseBasicParsing

cd C:\Users\chuan\todesk-ssh
.\frp_0.69.1_windows_amd64\frpc.exe -c .\frpc.toml
```

ECS 端：

```bash
ssh root@60.205.213.254 'systemctl status frps --no-pager -l; ss -tlnp | grep -E "(:7000|:2222|:9000|:9999)([[:space:]]|$)"'
```

公网端：

```bash
ssh -p 2222 admin@60.205.213.254 hostname
curl --noproxy '*' -i http://60.205.213.254:9000/health
curl --noproxy '*' -i http://60.205.213.254:9999/health
```

如果 ECS 本机访问 `127.0.0.1:9000/health` 已经返回 HTTP 200，但公网
`curl http://60.205.213.254:9000/health` 失败，不要继续改 Windows
`frpc.toml`。先在 ECS 上抓包确认公网请求有没有到达网卡：

```bash
ssh root@60.205.213.254 'curl --noproxy "*" -i http://127.0.0.1:9000/health'
ssh root@60.205.213.254 'timeout 12 tcpdump -nni any tcp port 9000 -tttt -vv -c 10'
```

本机 `127.0.0.1:9000` 成功但抓不到公网请求包，说明 `frps -> frpc -> LLM`
已经通了，剩余问题在阿里云安全组或 EIP 公网入口的 `9000/tcp` 放行。

## 9. 成功标准

全部满足才算完成：

```text
Windows: ssh -p 22222 admin@127.0.0.1 hostname 成功
Windows: Invoke-WebRequest http://192.168.100.12:8000/health 成功
Windows: Invoke-WebRequest http://192.168.100.12:9999/health 成功
Windows: frpc 日志显示 login to server success / start proxy success
ECS: ss 能看到 frps 监听 *:7000、*:2222、*:9000 和 *:9999
公网: ssh -p 2222 admin@60.205.213.254 hostname 成功
公网: curl http://60.205.213.254:9000/health 返回 HTTP 200
公网: curl http://60.205.213.254:9999/health 返回 HTTP 200
```
