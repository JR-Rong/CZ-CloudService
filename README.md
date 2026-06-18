# CZ CloudService

CZ CloudService stores deployment guides, client scripts, and future UI code for cloud-assisted access to local services.

## Layout

- `docs/frp/` - FRP deployment and troubleshooting guides.
- `scripts/windows/` - Windows client automation scripts.
- `examples/frp/` - Safe example FRP configuration files with placeholders only.
- `apps/ui/` - Reserved for future UI work.

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
