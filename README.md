# CZ CloudService

CZ CloudService stores deployment guides, client scripts, and future UI code for cloud-assisted access to local services.

## Layout

- `docs/frp/` - FRP deployment and troubleshooting guides.
- `docs/nextcloud/` - Nextcloud private drive deployment guides.
- `deploy/nextcloud-frp/` - Docker Compose stack for Nextcloud through the existing ECS `frps`.
- `scripts/windows/` - Windows client automation scripts.
- `scripts/unix/` - Unix shell utilities for deployment operations and backups.
- `examples/frp/` - Safe example FRP configuration files with placeholders only.
- `apps/ui/` - Reserved for future UI work.

## Windows File Browser Drive

The current deployed web drive is File Browser on the Windows storage machine:

```text
browser -> 60.205.213.254:2233 -> frps -> Windows frpc -> 127.0.0.1:2233 filebrowser
```

Install or update the service on a Windows machine from PowerShell. The same command can be reused on a new Windows host, and `-Port` controls the web drive port:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-filebrowser-drive.ps1 `
  -AdminPassword "<windows-admin-password>" `
  -Port 2233 `
  -InitialUser "alice:UserPassword123!,bob:UserPassword123!"
```

What the installer configures:

- Web UI locale defaults to `zh-cn`.
- The sidebar shows two file-space entries: `私人空间` and `共享空间`.
- Admin user is created or updated with full user-management permission, default password `123456`.
- Each `-InitialUser` gets an isolated scope under `data\_users\<username>`.
- Each normal user home contains one shared-space folder linked to `data\_shared`, and one private-space folder visible only inside that user's scope.
- The Windows scheduled task `CZCloudDrive` starts File Browser on boot.
- The Windows scheduled task `CZCloudDriveWorkspaceSync` runs on boot and every 5 minutes, so normal users created later by the admin web UI are moved into the same shared/private workspace model.

Full documentation and one-click remote deployment:

- [Windows File Browser drive deployment](docs/filebrowser/windows-filebrowser-drive-deployment.md)
- [Deployment change log](docs/deployment-change-log.md)

One-click deploy from macOS/Linux:

```bash
CZ_SSH_PASSWORD=123456 \
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-filebrowser-drive-remote.sh
```

If the Windows host already has the SSH `frpc.toml` created by `scripts/windows/setup-frpc.ps1`, expose the web drive through the same ECS `frps` with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-cloud-drive-frpc.ps1 `
  -AdminPassword "<windows-admin-password>" `
  -Port 2233
```

This creates the separate scheduled task `CZCloudDriveFrpc`, leaves the SSH tunnel config untouched, and forwards `remotePort = localPort = <Port>`.

## Nextcloud Private Drive Through FRP

This repository also keeps an optional Nextcloud deployment template. It is not used by the current Windows 2233 deployment.

```text
browser -> 60.205.213.254:2233 -> frps -> storage-machine frpc -> nextcloud:80
```

Start with the deployment guide:

- [Nextcloud private drive FRP deployment](docs/nextcloud/private-drive-frp-deployment.md)

The deployment stack lives in `deploy/nextcloud-frp/` and includes:

- Nextcloud `stable-apache`
- MariaDB LTS
- Redis
- Nextcloud cron
- frpc `v0.69.1`

Copy `.env.example` and `frpc.toml.example`, then fill secrets locally. Do not commit real `.env` or `frpc.toml` files.

## Windows FRP SSH Client

The current supported path exposes a Windows OpenSSH Server through an ECS-hosted `frps`:

```text
external ssh client -> ECS:2222 -> frps -> Windows frpc -> 127.0.0.1:22222 sshd
```

Read the full runbook first:

- [Windows client deployment guide](docs/frp/windows-client-deployment-guide.md)

Then run the Windows setup script from an elevated or normal PowerShell session after Windows OpenSSH Server is already listening on `127.0.0.1:22222`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<same-token-as-frps>" `
  -CreateStartupShortcut
```

The script writes `frpc.toml` under `C:\Users\<user>\todesk-ssh`, starts `frpc`, and optionally creates a startup shortcut for the current Windows user.

## Secret Handling

Never commit real FRP tokens, SSH private keys, subscription links, or generated `frpc.toml` files. Use `examples/frp/frpc.example.toml` as the template and provide secrets at runtime.
