# Web Disk Documentation

当前网页网盘方案是 Windows 主机上的自定义 File Browser，通过 FRP 暴露到公网 `2233`。

```text
browser -> 60.205.213.254:2233 -> cloud frps -> Windows frpc -> 127.0.0.1:2233 -> File Browser
```

核心文档：

- [网盘 + frpc 一键部署教程](filebrowser-frpc-one-click.md)
- [网盘系统说明与部署流程](system-process.md)

相关脚本和补丁：

- `scripts/unix/deploy-webdisk-webpage.sh`
- `scripts/unix/deploy-filebrowser-drive-remote.sh`
- `scripts/windows/install-filebrowser-drive.ps1`
- `scripts/windows/setup-cloud-drive-frpc.ps1`
- `patches/filebrowser/cz-spaces-v2.63.15.patch`
- `tests/verify-filebrowser-drive.sh`

当前线上约定：

| 项目 | 值 |
| --- | --- |
| 公网访问 | `http://60.205.213.254:2233` |
| Windows SSH | `ssh -p 2222 admin@60.205.213.254` |
| Windows 安装目录 | `C:\CZCloudDrive` |
| File Browser 数据目录 | `C:\CZCloudDrive\data` |
| File Browser 服务任务 | `CZCloudDrive` |
| 2233 frpc 任务 | `CZCloudDriveFrpc` |
| 用户工作区同步任务 | `CZCloudDriveWorkspaceSync` |

功能模型：

- `私人空间`：每个普通用户只看见自己的私有目录，只能增删改查自己的文件。
- `共享空间`：所有普通用户进入同一个公共 `_shared` 目录，都可以增删改查。
- 管理员仍使用 File Browser 的用户管理能力，但根目录也提供同名入口，便于浏览和排障。

安全提醒：

- 文档中的 `123456` 是当前受控环境的默认密码约定；正式使用前应更换。
- 不要提交真实 FRP token、SSH key、`.env`、`frpc.toml`、网盘数据或备份文件。
- `scripts/unix/deploy-webdisk-webpage.sh` 会重新构建并替换远端 `filebrowser.exe`，替换前会保留旧二进制备份。
