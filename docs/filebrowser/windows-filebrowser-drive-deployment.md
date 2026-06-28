# Windows File Browser 网盘部署说明

本文档记录当前 `60.205.213.254:2233` 网页网盘的全部仓库化改动、远端部署方式和验证方法。

## 当前线上形态

当前 2233 端口运行的是 Windows 主机上的自定义 File Browser，不是本仓库里的 Nextcloud 备用模板。

```text
browser
  -> http://60.205.213.254:2233
  -> ECS frps
  -> Windows frpc task CZCloudDriveFrpc
  -> 127.0.0.1:2233
  -> File Browser task CZCloudDrive
```

远端 Windows 入口：

- SSH: `admin@60.205.213.254 -p 2222`
- File Browser URL: `http://60.205.213.254:2233`
- Web admin user: `admin`
- Web admin default password: `123456`
- Windows install dir: `C:\CZCloudDrive`
- Data dir: `C:\CZCloudDrive\data`

## 已做修改

### 1. 自定义 File Browser 前端

补丁文件：

- `patches/filebrowser/cz-spaces-v2.63.15.patch`

改动点：

- 将官方侧边栏的单个 `My Files` 入口替换为两个真实按钮。
- `私人空间` 跳转到 `/files/私人空间`。
- `共享空间` 跳转到 `/files/共享空间`。
- 这不是 CSS 伪装，按钮存在于编译后的 Vue 前端 bundle 中。

### 2. 自定义 File Browser 后端

File Browser 的 `ScopedFs` 默认会阻止普通用户 scope 中的符号链接跳出自己的目录。这个安全行为本身正确，但会导致每个用户目录里的 `共享空间` 无法指向公共 `_shared`。

补丁只放开一个窄例外：

- 用户 scope 形如 `data/_users/<username>` 时，允许符号链接解析到同一个 `data/_shared`。
- 仍然拒绝指向其他用户目录或任意 sibling 目录。
- 补丁内包含回归测试：`_shared` 可访问，`_users/bob` 仍被拒绝。

### 3. Windows 安装脚本

脚本：

- `scripts/windows/install-filebrowser-drive.ps1`

功能：

- 安装或更新 `C:\CZCloudDrive\filebrowser.exe`。
- 配置监听 `0.0.0.0:2233`。
- 设置 `zh-cn`。
- 设置默认 web admin 密码 `123456`。
- 创建根目录下的 `私人空间` 与 `共享空间`。
- 为普通用户创建 `data\_users\<username>\私人空间`。
- 为普通用户创建 `data\_users\<username>\共享空间`，目标为公共 `data\_shared`。
- 使用 `mklink /D` 创建目录符号链接；不能用 junction，否则 File Browser 在 Windows 上会把共享入口识别异常。
- 注册 `CZCloudDrive` 计划任务，开机启动 File Browser。
- 注册 `CZCloudDriveWorkspaceSync`，开机和每 5 分钟同步一次后来在 Web UI 创建的普通用户，使其也进入私人/共享空间模型。

### 4. Windows FRP 暴露脚本

脚本：

- `scripts/windows/setup-cloud-drive-frpc.ps1`

功能：

- 复用已有 SSH FRP 配置中的 `serverAddr`、`serverPort` 和 token。
- 生成独立 `frpc-cloud-drive.toml`。
- 注册 `CZCloudDriveFrpc` 计划任务。
- 将远端 `2233` 转发到 Windows 本地 `127.0.0.1:2233`。

### 5. 一键部署脚本

脚本：

- `scripts/unix/deploy-filebrowser-drive-remote.sh`

用途：从 macOS/Linux 一键完成以下动作：

1. 拉取官方 File Browser `v2.63.15`。
2. 应用 `patches/filebrowser/cz-spaces-v2.63.15.patch`。
3. 用 Docker 编译前端和 Windows x64 后端二进制。
4. 通过 SSH/SCP 上传到 Windows 主机。
5. 替换远端 `filebrowser.exe`，保留旧 binary 备份。
6. 运行 Windows 安装脚本和 FRP 脚本。
7. 验证公网 2233、前端 bundle、admin 登录、私人空间和共享空间 API。

## 一键部署

前置条件：

- 本机安装 `git`、`docker`、`ssh`、`scp`、`curl`、`python3`。
- 如果使用密码 SSH，安装 `sshpass` 并设置 `CZ_SSH_PASSWORD`。
- 远端 Windows 已经能通过 `admin@60.205.213.254 -p 2222` 登录。
- 远端已有基础 FRP SSH 配置和 `frpc.exe`，即 `scripts/windows/setup-frpc.ps1` 已经部署过。

推荐命令：

```bash
CZ_SSH_PASSWORD=123456 \
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-filebrowser-drive-remote.sh
```

如果当前机器已经配置了 SSH key，可以省略 `CZ_SSH_PASSWORD`：

```bash
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-filebrowser-drive-remote.sh
```

常用参数通过环境变量覆盖：

```bash
CZ_DRIVE_HOST=60.205.213.254
CZ_DRIVE_SSH_PORT=2222
CZ_DRIVE_SSH_USER=admin
CZ_DRIVE_PORT=2233
CZ_SETUP_FRPC=1
CZ_FILEBROWSER_VERSION=v2.63.15
CZ_FRONTEND_BUILD_MODE=auto
```

默认会验证核心访问路径：公网首页、定制前端 bundle、admin 登录、`私人空间` 和 `共享空间` API。

`CZ_FRONTEND_BUILD_MODE=auto` 会优先使用本机 `pnpm`，没有 `pnpm` 时使用 `node:22-bookworm` Docker 镜像。也可以显式设置为 `local` 或 `docker`。

## 手动部署

如果只想在 Windows 主机上运行脚本，先确保 `filebrowser.exe` 已经是应用过补丁的自定义二进制，然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File C:\CZCloudDrive\install-filebrowser-drive.ps1 `
  -AdminPassword 123456 `
  -WebPassword 123456 `
  -Port 2233
```

再启动 2233 的 FRP 暴露：

```powershell
powershell -ExecutionPolicy Bypass -File C:\CZCloudDrive\setup-cloud-drive-frpc.ps1 `
  -AdminPassword 123456 `
  -Port 2233
```

## 验证

本地静态检查：

```bash
tests/verify-filebrowser-drive.sh
```

公网 API 检查：

```bash
TOKEN="$(curl -fsS -X POST http://60.205.213.254:2233/api/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"123456"}')"

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E7%A7%81%E4%BA%BA%E7%A9%BA%E9%97%B4

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E5%85%B1%E4%BA%AB%E7%A9%BA%E9%97%B4
```

远端任务检查：

```powershell
Get-ScheduledTask -TaskName CZCloudDrive,CZCloudDriveFrpc,CZCloudDriveWorkspaceSync |
  Select-Object TaskName,State

Get-NetTCPConnection -LocalPort 2233 -State Listen
```

## 安全说明

- `123456` 是本次按需求配置的默认密码，适合当前受控测试环境；正式使用前应改成强密码。
- 不要提交真实 FRP token、`.env`、`frpc.toml`、SSH key 或网盘数据。
- `deploy/nextcloud-frp/` 是备用 Nextcloud 方案模板，不代表当前 2233 线上服务。
