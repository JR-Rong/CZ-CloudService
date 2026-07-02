# 网盘系统说明与部署流程

本文档说明当前网页网盘的系统组成、目录模型、权限模型、部署流程和运维检查点。

## 1. 系统组成

```text
公网用户浏览器
  |
  | HTTP :2233
  v
公网 ECS frps
  |
  | FRP tcp proxy remotePort=2233
  v
Windows frpc scheduled task: CZCloudDriveFrpc
  |
  | 127.0.0.1:2233
  v
Windows File Browser scheduled task: CZCloudDrive
  |
  v
C:\CZCloudDrive\data
```

涉及组件：

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| `frps` | 云端 ECS | 接收 Windows frpc 连接并暴露公网端口 |
| `CZCloudDriveFrpc` | Windows 计划任务 | 把公网 `2233` 转发到 Windows `127.0.0.1:2233` |
| `CZCloudDrive` | Windows 计划任务 | 运行自定义 File Browser |
| `CZCloudDriveWorkspaceSync` | Windows 计划任务 | 定期同步普通用户工作区结构 |
| `filebrowser.exe` | `C:\CZCloudDrive` | 已打补丁的 File Browser Windows 二进制 |
| `filebrowser.db` | `C:\CZCloudDrive` | File Browser 用户、配置和权限数据库 |

## 2. 数据目录模型

```text
C:\CZCloudDrive
  filebrowser.exe
  filebrowser.db
  branding\
    custom.css
  data\
    私人空间\
    共享空间 -> data\_shared
    _shared\
    _users\
      alice\
        私人空间\
        共享空间 -> data\_shared
      bob\
        私人空间\
        共享空间 -> data\_shared
```

说明：

- `_shared` 是真实公共目录。
- 每个普通用户的 `共享空间` 是目录符号链接，目标是 `_shared`。
- 每个普通用户的 `私人空间` 是普通目录，仅位于该用户自己的 scope 内。
- 管理员 scope 为 `/`，所以根级也创建 `私人空间` 和 `共享空间` 以便管理。
- 使用 `mklink /D` 创建目录符号链接；junction 在 Windows File Browser 下会造成共享入口识别异常。

## 3. 权限模型

File Browser 普通用户 scope：

```text
/_users/<username>
```

结果：

- 用户只能通过 File Browser 看见自己的 `私人空间` 和 `共享空间`。
- 用户不能访问 `/_users/<other-user>`。
- 所有普通用户通过 `共享空间` 进入同一个 `_shared`。
- `共享空间` 支持创建、读取、修改、重命名、删除、下载和分享，取决于 File Browser 用户权限。

自定义后端补丁：

- File Browser 默认拒绝普通用户 scope 内指向 scope 外部的 symlink。
- 当前补丁改动 File Browser 的 `ScopedFs.within` 判断，只允许 `/_users/<username>/共享空间` 解析到同一数据根下的 `_shared`。
- 指向其他用户目录或任意 sibling 目录仍会被拒绝。
- 回归测试位于 `patches/filebrowser/cz-spaces-v2.63.15.patch` 中。

## 4. 定制前端

自定义 File Browser 前端将官方单一 `My Files` 入口替换为两个真实按钮：

| 按钮 | 路由 |
| --- | --- |
| `私人空间` | `/files/私人空间` |
| `共享空间` | `/files/共享空间` |

这两个入口是在 Vue 组件中编译生成，不是通过 CSS 改字或伪元素伪装。

## 5. 部署流程

### 5.1 云端 frps

云端负责：

- 监听 `7000/tcp` 供 frpc 控制连接。
- 允许 `2233/tcp` 作为公网网盘端口。

检查：

```bash
systemctl is-active frps
ss -tlnp | grep -E '(:7000|:2233)([[:space:]]|$)' || true
```

### 5.2 构建自定义 File Browser

一键脚本 `scripts/unix/deploy-webdisk-webpage.sh` 负责：

1. 拉上游 `filebrowser/filebrowser v2.63.15`。
2. 应用仓库 patch。
3. 构建前端 bundle。
4. 交叉编译 Windows x64 二进制。

产物：

```text
.work/filebrowser-build/source/filebrowser-cz.exe
```

### 5.3 部署 Windows File Browser

Windows 安装脚本负责：

1. 停止旧 `CZCloudDrive`。
2. 停止旧 2233 listener。
3. 初始化或更新 `filebrowser.db`。
4. 设置监听、语言、branding、root。
5. 创建或更新 admin。
6. 创建根目录和普通用户目录模型。
7. 注册 `CZCloudDrive` 和 `CZCloudDriveWorkspaceSync`。
8. 验证 2233 本地监听。

### 5.4 部署 Windows frpc

FRPC 脚本负责：

1. 读取已有 SSH FRP 配置。
2. 生成 `frpc-cloud-drive.toml`。
3. 注册 `CZCloudDriveFrpc`。
4. 启动 frpc 并注册 `remotePort = 2233`。

## 6. 运维检查

公网检查：

```bash
curl -fsS http://60.205.213.254:2233/ >/dev/null
```

File Browser API：

```bash
TOKEN="$(curl -fsS -X POST http://60.205.213.254:2233/api/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"123456"}')"

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E7%A7%81%E4%BA%BA%E7%A9%BA%E9%97%B4

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E5%85%B1%E4%BA%AB%E7%A9%BA%E9%97%B4
```

Windows 任务：

```powershell
Get-ScheduledTask -TaskName CZCloudDrive,CZCloudDriveFrpc,CZCloudDriveWorkspaceSync |
  Select-Object TaskName,State
```

端口：

```powershell
Get-NetTCPConnection -LocalPort 2233 -State Listen
```

## 7. 常见故障

### 共享空间 500

常见原因：

- 使用了 junction，而不是目录符号链接。
- 普通用户 scope 外部 symlink 被 File Browser 默认安全逻辑拒绝。
- 远端运行的不是打补丁后的 `filebrowser.exe`。

处理：

1. 重新运行一键部署脚本。
2. 检查 `filebrowser.exe` 哈希是否更新。
3. 检查用户目录里的 `共享空间` 是否是 `SymbolicLink`。

### 2233 打不开

检查顺序：

1. Windows `CZCloudDrive` 是否运行。
2. Windows 本地是否监听 `2233`。
3. Windows `CZCloudDriveFrpc` 是否运行。
4. frpc 日志是否出现 `login to server success` 和 `start proxy success`。
5. 云端 frps 是否允许并监听 `2233`。
6. 云安全组是否放行 `2233/tcp`。

### 新建用户没有两个空间

处理：

```powershell
Start-ScheduledTask -TaskName CZCloudDriveWorkspaceSync
```

或者重新运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File C:\CZCloudDrive\install-filebrowser-drive.ps1 `
  -AdminPassword 123456 `
  -WebPassword 123456 `
  -Port 2233
```

## 8. 安全和备份

- `filebrowser.db` 包含用户配置和密码哈希，应随 `data` 一起备份。
- `data\_shared` 是所有用户共享区，误删会影响所有人。
- `data\_users` 是用户私有区，误删会影响对应用户。
- 真实 FRP token 不进入仓库。
- 正式环境应替换默认密码 `123456`。
