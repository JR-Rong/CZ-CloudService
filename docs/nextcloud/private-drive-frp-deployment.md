# Nextcloud 企业私有网盘 frp 部署教程

目标：在实际存储机器上部署 Nextcloud，并通过已经存在的公网 `frps` 暴露为：

```text
http://60.205.213.254:2233
```

访问链路：

```text
员工浏览器
  -> 60.205.213.254:2233
  -> 公网 ECS frps
  -> 存储机器 frpc
  -> Docker 网络 nextcloud:80
  -> Nextcloud
```

## 1. 前置条件

- 存储机器已安装 Docker 和 Docker Compose。
- 存储机器可以主动连接 `60.205.213.254:7000`。
- 公网机器上的 `frps allowPorts` 已允许 `2233`，阿里云安全组也已放行 TCP `2233`。
- 已通过安全渠道拿到 `frps` token。不要把真实 token 写入仓库或聊天记录。

当前方案先使用 HTTP。它可以满足 frp 打通和内测，但企业密码和文件会明文传输，正式使用前建议改为域名 + HTTPS。

## 2. 准备配置

在仓库根目录执行：

```bash
cd deploy/nextcloud-frp
cp .env.example .env
cp frpc.toml.example frpc.toml
chmod 600 .env frpc.toml
```

编辑 `.env`，至少替换这些值：

- `NEXTCLOUD_ADMIN_PASSWORD`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`
- `FRPC_CONFIG_FILE=./frpc.toml`

公网访问相关配置保持如下：

```env
NEXTCLOUD_TRUSTED_DOMAINS="60.205.213.254 60.205.213.254:2233 localhost 127.0.0.1"
OVERWRITEHOST=60.205.213.254:2233
OVERWRITEPROTOCOL=http
OVERWRITECLIURL=http://60.205.213.254:2233
```

编辑 `frpc.toml`，把 token 换成公网 `frps` 的真实 token：

```toml
serverAddr = "60.205.213.254"
serverPort = 7000

auth.method = "token"
auth.token = "<replace-with-frps-token>"

[[proxies]]
name = "cz-nextcloud-http-2233"
type = "tcp"
localIP = "nextcloud"
localPort = 80
remotePort = 2233
```

这里 `localIP = "nextcloud"` 是 Docker Compose 内部服务名，不是公网 IP。

## 3. 启动

```bash
cd deploy/nextcloud-frp
docker compose --env-file .env up -d
```

查看状态：

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs -f frpc
```

本机验证：

```bash
curl -I http://127.0.0.1:8080/status.php
```

公网验证：

```bash
curl -I http://60.205.213.254:2233/status.php
```

浏览器访问：

```text
http://60.205.213.254:2233
```

如果出现 `untrusted domain`，优先检查 `.env` 里的 `NEXTCLOUD_TRUSTED_DOMAINS`，然后重建 Nextcloud 容器：

```bash
docker compose --env-file .env up -d --force-recreate nextcloud cron
```

## 4. 用户、公共网盘和私人网盘

私人网盘：Nextcloud 每个本地用户自带个人文件空间，用户名就是员工标识。

创建员工账号：

```bash
../../scripts/unix/create-nextcloud-user.sh zhangsan 'replace-with-initial-password' '张三'
```

公共网盘有两种方式：

1. 简单方式：管理员创建一个 `公司公共网盘` 文件夹，并共享给 `employees` 组。
2. 更正式方式：在 Nextcloud 应用市场启用 `Group folders`，创建公司公共群组文件夹，再授权给 `employees` 组。

第一版建议先用简单方式上线，后续再根据部门权限复杂度决定是否启用 `Group folders`。

## 5. 上传大小

默认模板设置：

```env
PHP_MEMORY_LIMIT=1024M
PHP_UPLOAD_LIMIT=2048M
APACHE_BODY_LIMIT=0
```

如果要传更大的文件，除了修改 `.env`，还要结合公网机带宽、frp 超时、浏览器稳定性一起验证。

## 6. 备份

备份脚本会做三件事：

- 打开 Nextcloud maintenance mode。
- 使用 `mariadb-dump` 导出数据库。
- 打包 Nextcloud 文件、配置、应用和主题目录。

手动执行：

```bash
../../scripts/unix/backup-nextcloud.sh
```

默认备份目录：

```text
deploy/nextcloud-frp/data/backups/<timestamp>/
```

默认保留 14 天，可在 `.env` 中设置：

```env
BACKUP_RETENTION_DAYS=14
```

Linux cron 示例：

```cron
0 3 * * * cd /path/to/CZ-CloudService/deploy/nextcloud-frp && /path/to/CZ-CloudService/scripts/unix/backup-nextcloud.sh >> /path/to/CZ-CloudService/deploy/nextcloud-frp/data/backups/backup.log 2>&1
```

备份里包含数据库、配置和文件数据，必须按企业数据同等敏感级别保护。

## 7. 常用运维命令

查看 Nextcloud 状态：

```bash
docker compose --env-file .env exec -u www-data nextcloud php occ status
```

查看系统配置：

```bash
docker compose --env-file .env exec -u www-data nextcloud php occ config:list system
```

关闭：

```bash
docker compose --env-file .env down
```

升级镜像前先备份，然后执行：

```bash
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

## 8. 后续改为 HTTPS

正式使用建议准备域名，例如 `cloud.example.com`：

1. 域名解析到 `60.205.213.254`。
2. 在公网机或存储机器入口配置 HTTPS 证书。
3. 修改 `.env`：

```env
NEXTCLOUD_TRUSTED_DOMAINS=cloud.example.com 60.205.213.254
OVERWRITEHOST=cloud.example.com
OVERWRITEPROTOCOL=https
OVERWRITECLIURL=https://cloud.example.com
```

4. 重新创建 Nextcloud 和 cron 容器。
