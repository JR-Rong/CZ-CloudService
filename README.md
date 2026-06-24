# CZ CloudService

CZ CloudService stores deployment guides, client scripts, and future UI code for cloud-assisted access to local services.

## Layout

- `docs/frp/` - FRP deployment and troubleshooting guides.
- `docs/operations/` - Port and autostart inventory across FRP, SSH, and AI services.
- `docs/ai-stack/` - AI server GPU layout, model deployment, and operations runbooks.
- `scripts/cloud/` - Cloud server deployment helpers.
- `scripts/windows/` - Windows client automation scripts.
- `scripts/ai-stack/` - AI server status, smoke test, rebalance, context, and rollback helpers.
- `examples/frp/` - Safe example FRP configuration files with placeholders only.
- `apps/ui/` - Reserved for future UI work.

## Windows FRP SSH Client

The current supported path exposes a Windows OpenSSH Server through an ECS-hosted `frps`:

```text
external ssh client -> ECS:2222 -> frps -> Windows frpc -> 127.0.0.1:22222 sshd
```

Read the full runbook first:

- [Windows client deployment guide](docs/frp/windows-client-deployment-guide.md)
- [Cloud frps deployment guide](docs/frp/server-deployment-guide.md)
- [Ports and autostart inventory](docs/operations/ports-and-autostart.md)

Then run the Windows setup script from an elevated or normal PowerShell session after Windows OpenSSH Server is already listening on `127.0.0.1:22222`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<same-token-as-frps>" `
  -CreateStartupShortcut
```

The script writes `frpc.toml` under `C:\Users\<user>\todesk-ssh`, starts `frpc`, and optionally creates a startup shortcut for the current Windows user.

For machine-level autostart, use the script's Scheduled Task option instead of the current-user Startup shortcut. See the Windows guide for the at-logon versus at-startup tradeoff.

## Cloud FRP Server

Use the cloud setup script on an Ubuntu/systemd ECS host. It is dry-run by default and only installs/writes/enables `frps` when `--apply` is present:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" bash scripts/cloud/setup-frps.sh --apply
```

The script targets `frps` `0.69.1`, writes `/etc/frp/frps.toml`, writes `/etc/systemd/system/frps.service`, and enables/starts the service only in apply mode. Use `examples/frp/frps.example.toml` as a placeholder-only reference.

## Secret Handling

Never commit real FRP tokens, SSH private keys, subscription links, or generated `frpc.toml` / `frps.toml` files. Use `examples/frp/*.example.toml` as templates and provide secrets at runtime.

## AI Stack Operations

Current AI server deployment notes and helper scripts are documented here:

- [Current AI server deployment](docs/ai-stack/current-deployment.md)
- [Qwen3.6 GPU rebalance change log](docs/ai-stack/change-log-2026-06-24-qwen36-rebalance.md)
- [AI stack runbook](docs/ai-stack/runbook.md)

The AI helper scripts intentionally do not store SSH passwords or API keys. Run them on the AI server after logging in, or use the connection helper to open an interactive session.
