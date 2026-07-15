# CZ CloudService

CZ CloudService stores deployment guides, client scripts, and future UI code for cloud-assisted access to local services.

## Layout

- `docs/frp/` - FRP deployment and troubleshooting guides.
- `docs/webdisk/` - File Browser web disk deployment and operations docs.
- `docs/operations/` - Port and autostart inventory across FRP, SSH, and AI services.
- `docs/ai-stack/` - AI server GPU layout, model deployment, and operations runbooks.
- `docs/agent-platform/` - Hermes Agent management platform design and deployment docs.
- `scripts/cloud/` - Cloud server deployment helpers.
- `scripts/windows/` - Windows client automation scripts.
- `scripts/unix/` - macOS/Linux deployment helpers.
- `scripts/ai-stack/` - AI server status, smoke test, rebalance, context, and rollback helpers.
- `examples/frp/` - Safe example FRP configuration files with placeholders only.
- `apps/ui/` - Hermes Agent management web app.
- `apps/ai-chat/` - Browser chat UI and server-side gateway for the private LLM.
- `apps/safety/` - Standalone physical-server edge security project (WireGuard, firewall, SSH hardening, rollback, and onsite acceptance). It is independent of FRP.
- `agent-platform/` - Operator entrypoints for Hermes image contract checks.

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

## Web Disk

The current web disk uses a custom File Browser binary on Windows and exposes it
through a dedicated frpc proxy:

```text
browser -> 60.205.213.254:2233 -> frps -> Windows frpc -> 127.0.0.1:2233 -> File Browser
```

Start here:

- [Web disk documentation index](docs/webdisk/README.md)
- [Web disk + frpc one-click deployment](docs/webdisk/filebrowser-frpc-one-click.md)
- [Web disk system and process documentation](docs/webdisk/system-process.md)

One-click deploy from macOS/Linux:

```bash
CZ_SSH_PASSWORD=123456 \
CZ_WINDOWS_ADMIN_PASSWORD=123456 \
CZ_FILEBROWSER_WEB_PASSWORD=123456 \
scripts/unix/deploy-webdisk-webpage.sh
```

`deploy-webdisk-webpage.sh` is the user-facing deployment entrypoint. It builds
the custom File Browser web UI, uploads the Windows binary and install scripts,
then restarts the `2233` web disk service through the lower-level
`deploy-filebrowser-drive-remote.sh` helper.

## Secret Handling

Never commit real FRP tokens, SSH private keys, subscription links, or generated `frpc.toml` / `frps.toml` files. Use `examples/frp/*.example.toml` as templates and provide secrets at runtime.

## Hermes Agent Platform

The management console runs from `apps/ui` and defaults to
`http://127.0.0.1:3080/` on the Windows AI host. Public access is routed through
the existing FRP server on `http://60.205.213.254:2444/`.

Read:

- [Hermes Agent platform design](docs/agent-platform/hermes-agent-platform-design.md)
- [Hermes Agent deployment guide](docs/agent-platform/deployment-guide.md)
- [Hermes Agent validation status](docs/agent-platform/validation-status.md)

## AI Stack Operations

Current AI server deployment notes and helper scripts are documented here:

- [Current AI server deployment](docs/ai-stack/current-deployment.md)
- [Qwen3.6 GPU rebalance change log](docs/ai-stack/change-log-2026-06-24-qwen36-rebalance.md)
- [AI stack runbook](docs/ai-stack/runbook.md)
- [AI Chat Web gateway](docs/ai-stack/ai-chat-web.md)

The AI helper scripts intentionally do not store SSH passwords or API keys. Run them on the AI server after logging in, or use the connection helper to open an interactive session.

The Qwen3.6 LLM service runs internally at `192.168.100.12:8000` and is exposed
through FRP at `http://60.205.213.254:9000/` when the Windows `frpc` client is
connected with the `ai-llm-qwen36-9000` proxy registered.

The AI Chat Web UI runs internally at `192.168.100.12:9999` and is exposed
through FRP at `http://60.205.213.254:9999/` when the Windows `frpc` client is
connected with the `ai-chat-web-9999` proxy registered. Port `9000` remains the
OpenAI-compatible API entrypoint.
