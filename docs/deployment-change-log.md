# 部署改动总览

本文档汇总本次提交进入仓库的部署相关改动。当前线上 `2233` 服务是 Windows File Browser 方案；Nextcloud 文件是备用方案模板。

## 当前线上方案：Windows File Browser

相关文件：

- `docs/filebrowser/windows-filebrowser-drive-deployment.md`
- `patches/filebrowser/cz-spaces-v2.63.15.patch`
- `scripts/unix/deploy-filebrowser-drive-remote.sh`
- `scripts/windows/install-filebrowser-drive.ps1`
- `scripts/windows/setup-cloud-drive-frpc.ps1`
- `tests/verify-filebrowser-drive.sh`

改动内容：

- File Browser 前端侧边栏改为两个真实按钮：`私人空间` 和 `共享空间`。
- File Browser 后端允许普通用户 scope 中的 `共享空间` 链接访问同一数据根下的 `_shared`，但继续阻止访问其他用户目录。
- Windows 安装脚本创建 `C:\CZCloudDrive\data\私人空间`、`C:\CZCloudDrive\data\共享空间`、`data\_users\<username>\私人空间` 和 `data\_users\<username>\共享空间`。
- 共享入口使用 `mklink /D` 目录符号链接，不使用 junction。
- `CZCloudDriveWorkspaceSync` 定时任务会把后续 Web UI 新建的普通用户同步到同一目录模型。
- `setup-cloud-drive-frpc.ps1` 复用已有 SSH FRP 配置，单独注册 `CZCloudDriveFrpc` 暴露 `2233`。
- `deploy-filebrowser-drive-remote.sh` 可以从 macOS/Linux 一键构建定制 File Browser、上传到 Windows、重启服务并验证公网入口。

## 备用方案：Nextcloud Through FRP

相关文件：

- `docs/nextcloud/private-drive-frp-deployment.md`
- `deploy/nextcloud-frp/docker-compose.yml`
- `deploy/nextcloud-frp/.env.example`
- `deploy/nextcloud-frp/frpc.toml.example`
- `scripts/unix/backup-nextcloud.sh`
- `scripts/unix/create-nextcloud-user.sh`
- `tests/verify-nextcloud-frp.sh`

改动内容：

- 新增 Nextcloud + MariaDB + Redis + cron + frpc 的 Docker Compose 模板。
- `.env.example` 记录公网 `60.205.213.254:2233`、trusted domains、上传限制和备份保留天数。
- `frpc.toml.example` 提供 `remotePort = 2233` 的安全占位模板，不包含真实 token。
- `backup-nextcloud.sh` 支持 maintenance mode、数据库 dump、文件归档和备份保留。
- `create-nextcloud-user.sh` 支持从命令行创建员工账号并加入 `employees` 组。

## 仓库保护

相关文件：

- `.gitignore`

改动内容：

- 继续忽略 `.env`、真实 `frpc.toml`、密钥、日志和下载包。
- 明确允许提交 `.env.example`。
- 忽略 `deploy/nextcloud-frp/data/` 和 `deploy/nextcloud-frp/frpc.toml`，避免提交真实网盘数据和 FRP token。
- 忽略 `.work/`，用于本地一键部署构建缓存。

## 验证入口

```bash
tests/verify-filebrowser-drive.sh
tests/verify-nextcloud-frp.sh
```

File Browser 线上验证可参考：

```bash
TOKEN="$(curl -fsS -X POST http://60.205.213.254:2233/api/login \
  -H 'Content-Type: application/json' \
  --data '{"username":"admin","password":"123456"}')"

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E7%A7%81%E4%BA%BA%E7%A9%BA%E9%97%B4

curl -fsS -H "X-Auth: $TOKEN" \
  http://60.205.213.254:2233/api/resources/%E5%85%B1%E4%BA%AB%E7%A9%BA%E9%97%B4
```
