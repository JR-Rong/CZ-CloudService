# 网盘 + frpc 一键部署教程

本文档说明如何从本机一键部署当前网页网盘：自定义 File Browser + Windows frpc + 公网 `2233`。

## 1. 部署目标

部署完成后，应满足：

- 浏览器访问 `http://60.205.213.254:2233`。
- File Browser 侧边栏显示两个真实入口：`私人空间`、`共享空间`。
- 普通用户的 `私人空间` 只属于自己。
- 所有普通用户的 `共享空间` 指向同一个公共目录。
- Windows 开机后自动启动 File Browser 和 2233 frpc。

访问链路：

```text
operator machine
  -> ssh -p 2222 admin@60.205.213.254
  -> Windows host
  -> C:\CZCloudDrive

browser
  -> 60.205.213.254:2233
  -> cloud frps
  -> Windows frpc task CZCloudDriveFrpc
  -> Windows 127.0.0.1:2233
  -> File Browser task CZCloudDrive
```

## 2. 前置条件

本机需要：

- `git`
- `docker`
- `ssh`
- `scp`
- `curl`
- `python3`
- 可选：`sshpass`，仅当没有配置 SSH key、需要密码 SSH 时使用。
- 可选：`pnpm`。有 `pnpm` 时一键脚本会优先本机编译前端；没有时会使用 Docker Node 镜像。

远端 Windows 需要：

- 能通过 `ssh -p 2222 admin@60.205.213.254` 登录。
- 已经有基础 FRP SSH 客户端目录，例如 `C:\Users\chuan\todesk-ssh`。
- 基础 FRP 配置 `frpc.toml` 中有可复用的 `serverAddr`、`serverPort`、`auth.method`、`auth.token`。
- `frp_0.69.1_windows_amd64\frpc.exe` 已存在。

云端 `frps` 需要：

- `7000/tcp` 控制端口可被 Windows frpc 连接。
- `allowPorts` 允许 `2233`。
- 云安全组放行 `2233/tcp`。

## 3. 一键部署命令

如果本机需要密码 SSH：

```bash
CZ_SSH_PASSWORD=123456 \
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-webdisk-webpage.sh
```

如果本机已经配置 SSH key：

```bash
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-webdisk-webpage.sh
```

默认目标：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CZ_DRIVE_HOST` | `60.205.213.254` | Windows SSH 和公网验证的默认目标 |
| `CZ_DRIVE_SSH_HOST` | 同 `CZ_DRIVE_HOST` | 仅覆盖 SSH/SCP 目标；在 ECS 上运行时可设为 `127.0.0.1` |
| `CZ_DRIVE_PUBLIC_HOST` | 同 `CZ_DRIVE_HOST` | 仅覆盖公网 HTTP 验证目标 |
| `CZ_DRIVE_SSH_PORT` | `2222` | Windows SSH 的公网 FRP 端口 |
| `CZ_DRIVE_SSH_USER` | `admin` | Windows SSH 用户 |
| `CZ_DRIVE_PORT` | `2233` | 网盘公网端口和 Windows 本地端口 |
| `CZ_DRIVE_INSTALL_DIR` | `C:/CZCloudDrive` | Windows 安装目录 |
| `CZ_FILEBROWSER_VERSION` | `v2.63.15` | 上游 File Browser 版本 |
| `CZ_SETUP_FRPC` | `1` | 是否部署 `CZCloudDriveFrpc` |
| `CZ_FRONTEND_BUILD_MODE` | `auto` | `auto`、`local` 或 `docker` |
| `CZ_NODE_IMAGE` | `node:22-bookworm` | Docker 前端构建镜像，可替换为可访问的镜像源 |
| `CZ_GO_BUILD_MODE` | `docker` | Go 构建方式：`docker` 或 `local` |
| `CZ_GO_IMAGE` | `golang:1.25` | Docker Go 构建镜像，可替换为可访问的镜像源 |

如果脚本是在云端 ECS/frps 主机上运行，推荐显式拆分 SSH 目标和公网验证目标：

```bash
CZ_DRIVE_SSH_HOST=127.0.0.1 \
CZ_DRIVE_PUBLIC_HOST=60.205.213.254 \
CZ_SSH_PASSWORD=123456 \
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-webdisk-webpage.sh
```

## 4. 一键脚本做了什么

主入口：`scripts/unix/deploy-webdisk-webpage.sh`

底层实现：`scripts/unix/deploy-filebrowser-drive-remote.sh`

步骤：

1. 克隆官方 File Browser `v2.63.15` 到 `.work/filebrowser-build/source`。
2. 应用 `patches/filebrowser/cz-spaces-v2.63.15.patch`。
3. 构建前端：
   - `auto` 模式优先使用本机 `pnpm install --frozen-lockfile && pnpm run build`。
   - 如果本机有 Node.js 和 Corepack，也可通过 `corepack pnpm` 本机构建。
   - 没有 `pnpm` 时使用 `node:22-bookworm` Docker 镜像。
4. 用 `golang:1.25` Docker 镜像交叉编译 Windows x64 `filebrowser-cz.exe`。
5. 上传以下文件到 Windows `C:\CZCloudDrive`：
   - `filebrowser-cz.exe`
   - `install-filebrowser-drive.ps1`
   - `setup-cloud-drive-frpc.ps1`
6. 停止远端旧 `CZCloudDrive` 和 2233 listener。
7. 备份旧 `filebrowser.exe`，替换为新的自定义二进制。
8. 运行 `install-filebrowser-drive.ps1`，配置 File Browser、用户目录和计划任务。
9. 运行 `setup-cloud-drive-frpc.ps1`，生成并启动 2233 的 frpc 计划任务。
10. 验证公网首页、定制前端 bundle、admin 登录、`私人空间` API、`共享空间` API。

## 5. Windows 侧脚本

### 5.1 安装 File Browser

脚本：`scripts/windows/install-filebrowser-drive.ps1`

手动执行示例：

```powershell
powershell -ExecutionPolicy Bypass -File C:\CZCloudDrive\install-filebrowser-drive.ps1 `
  -AdminPassword 123456 `
  -WebPassword 123456 `
  -Port 2233
```

关键行为：

- 设置监听 `0.0.0.0:2233`。
- 根目录为 `C:\CZCloudDrive\data`。
- 创建管理员 `admin`，默认 web 密码 `123456`。
- 创建根级 `私人空间` 和 `共享空间`。
- 为普通用户创建 `data\_users\<username>\私人空间`。
- 为普通用户创建 `data\_users\<username>\共享空间`，目标为 `data\_shared`。
- 共享入口使用 `mklink /D`，不用 junction。
- 注册并启动：
  - `CZCloudDrive`
  - `CZCloudDriveWorkspaceSync`

### 5.2 暴露 2233 frpc

脚本：`scripts/windows/setup-cloud-drive-frpc.ps1`

手动执行示例：

```powershell
powershell -ExecutionPolicy Bypass -File C:\CZCloudDrive\setup-cloud-drive-frpc.ps1 `
  -AdminPassword 123456 `
  -Port 2233
```

关键行为：

- 从已有 `C:\Users\chuan\todesk-ssh\frpc.toml` 读取 `serverAddr`、`serverPort` 和 token。
- 写入 `frpc-cloud-drive.toml`。
- 注册并启动计划任务 `CZCloudDriveFrpc`。
- 转发规则：`remotePort = 2233 -> localPort = 2233`。

## 6. 部署后验证

公网登录：

```bash
TOKEN="$(curl -fsS -X POST http://60.205.213.254:2233/api/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"123456"}')"
```

验证两个入口：

```bash
curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E7%A7%81%E4%BA%BA%E7%A9%BA%E9%97%B4

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E5%85%B1%E4%BA%AB%E7%A9%BA%E9%97%B4
```

远端任务：

```powershell
Get-ScheduledTask -TaskName CZCloudDrive,CZCloudDriveFrpc,CZCloudDriveWorkspaceSync |
  Select-Object TaskName,State

Get-NetTCPConnection -LocalPort 2233 -State Listen
```

仓库静态验证：

```bash
tests/verify-filebrowser-drive.sh
```

## 7. Docker Hub 拉取超时

如果看到类似错误：

```text
failed to resolve reference "docker.io/library/node:22-bookworm"
dial tcp ... i/o timeout
```

原因是当前机器访问 Docker Hub 超时，不是 File Browser 补丁失败。

可选处理方式：

1. 改用本机构建前端：

```bash
CZ_FRONTEND_BUILD_MODE=local scripts/unix/deploy-webdisk-webpage.sh
```

这需要本机已经安装 Node.js、Corepack 或 pnpm。

2. 改用本机 Go 构建二进制：

```bash
CZ_GO_BUILD_MODE=local scripts/unix/deploy-webdisk-webpage.sh
```

这需要本机已经安装 Go，并且版本足够构建 File Browser。

3. 使用当前服务器可访问的镜像源：

```bash
CZ_NODE_IMAGE=<your-registry>/library/node:22-bookworm \
CZ_GO_IMAGE=<your-registry>/library/golang:1.25 \
scripts/unix/deploy-webdisk-webpage.sh
```

也可以先手动 `docker pull` 对应镜像，成功后再重新运行一键脚本。

## 8. 回滚

一键脚本替换 `filebrowser.exe` 前会备份旧文件：

```text
C:\CZCloudDrive\filebrowser-backup-<timestamp>.exe
```

回滚步骤：

```powershell
Stop-ScheduledTask -TaskName CZCloudDrive -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 2233 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Copy-Item C:\CZCloudDrive\filebrowser-backup-<timestamp>.exe C:\CZCloudDrive\filebrowser.exe -Force
Start-ScheduledTask -TaskName CZCloudDrive
```

FRPC 回滚可停用独立任务：

```powershell
Stop-ScheduledTask -TaskName CZCloudDriveFrpc -ErrorAction SilentlyContinue
```
