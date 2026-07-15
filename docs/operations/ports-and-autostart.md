# Ports and Autostart Inventory

This inventory covers the completed non-webdisk deployment surface.

## FRP Server

| Item | Value |
| --- | --- |
| Host role | Cloud Ubuntu/systemd ECS host |
| Binary | `/usr/local/bin/frps` |
| Config | `/etc/frp/frps.toml` |
| Service | `/etc/systemd/system/frps.service` |
| Autostart | `systemctl enable --now frps.service` through `scripts/cloud/setup-frps.sh --apply` |
| Ports | `7000/tcp` control, `2222/tcp` public SSH proxy, `2444/tcp` Hermes Agent web proxy, `9000/tcp` public LLM API proxy, `9999/tcp` public AI chat web proxy |
| Allow list | `allowPorts = [{ start = 2222, end = 2222 }, { start = 2444, end = 2444 }, { start = 9000, end = 9000 }, { start = 9999, end = 9999 }]` for the managed deployment |

Notes:

- `7000/tcp` must be reachable from the Windows `frpc` client.
- `2222/tcp`, `2444/tcp`, `9000/tcp`, and `9999/tcp` should be restricted to
  operator or company source IPs in the cloud security group where possible.
- Additional Windows clients need unique remote ports, matching `allowPorts`,
  cloud security group rules, and client `remotePort` values.

## FRP Windows Client

| Item | Value |
| --- | --- |
| Host role | Windows client/bastion |
| Binary | `C:\Users\<user>\todesk-ssh\frp_0.69.1_windows_amd64\frpc.exe` by default |
| Config | `C:\Users\<user>\todesk-ssh\frpc.toml` by default |
| Current-user autostart | `-CreateStartupShortcut`, creates a Startup folder shortcut |
| Scheduled Task autostart | `-RegisterScheduledTask -ScheduledTaskTrigger AtLogon` for current-user logon, or `AtStartup` from elevated PowerShell |
| Ports | Connects to cloud `7000/tcp`; registers cloud `2222/tcp` for SSH, `2444/tcp` for Hermes Agent web, `9000/tcp` for the AI LLM API, and `9999/tcp` for AI Chat Web; forwards to local `127.0.0.1:22222`, `127.0.0.1:3080`, `192.168.100.12:8000`, and `192.168.100.12:9999` |

Use the current-user Startup shortcut when frpc only needs to run after that
user signs in. Use the Scheduled Task option for clearer Task Scheduler
visibility or startup-time execution. `AtStartup` runs as `SYSTEM`, requires
elevated PowerShell, and should use an install directory readable by `SYSTEM`.

## Windows sshd

| Item | Value |
| --- | --- |
| Service | `sshd` |
| Config | `C:\ProgramData\ssh\sshd_config` |
| Autostart | `Set-Service sshd -StartupType Automatic` |
| Port | `127.0.0.1:22222` |

The Windows SSH service should bind to localhost only. Public exposure is through
FRP `remotePort = 2222`, not direct Windows firewall exposure.

## Hermes Agent Platform

| Item | Value |
| --- | --- |
| App | `apps/ui/src/server.js` |
| Local URL | `http://127.0.0.1:3080/` |
| Public URL | `http://60.205.213.254:2444/` |
| Runtime state | `C:\ProgramData\CZ-CloudService\agent-platform\state.json` on Windows |
| Runtime env files | `C:\ProgramData\CZ-CloudService\agent-platform\runtime\hermes-*.env` |
| Startup helper | `scripts/windows/setup-agent-platform.ps1 -RegisterScheduledTask -ScheduledTaskTrigger AtLogon`, or elevated `-ScheduledTaskTrigger AtStartup` |

## AI Services

| Service | Port | Expected autostart | Current role |
| --- | --- | --- | --- |
| `ai-llm.service` | `8000` | enabled | Qwen3.6 FP8 LLM and multimodal endpoint |
| `ai-vlm.service` | `8001` | disabled | Old Qwen2.5-VL endpoint, intentionally inactive |
| `ai-speech.service` | `8002` | enabled | SenseVoiceSmall speech recognition |
| `ai-comfy.service` | `8188` | enabled | Primary ComfyUI instance |
| `ai-comfy-gpu2.service` | `8189` | enabled | Secondary ComfyUI instance |
| `ai-chat-web.service` | `9999` | enabled | Browser chat UI and server-side LLM proxy |

Public LLM exposure:

- URL: `http://60.205.213.254:9000/`
- FRP proxy: `remotePort = 9000`
- Windows-side target: `192.168.100.12:8000`
- Expected checks: `/health` returns HTTP `200`; `/v1/models` requires the
  runtime API key and should identify `qwen3.6-35b-a3b` when authorized.

Public AI Chat Web exposure:

- URL: `http://60.205.213.254:9999/`
- FRP proxy: `remotePort = 9999`
- Windows-side target: `192.168.100.12:9999`
- Expected checks: `/health` returns HTTP `200`; `/` serves the browser chat UI.
- The web service keeps the real LLM API key server-side and proxies model
  calls to `192.168.100.12:8000`.

Rollback safety:

- `scripts/ai-stack/rollback-ai-stack-backup.sh --apply` restores files and
  restarts only services that are currently enabled.
- Use `--restart-disabled` only when intentionally reviving a disabled service
  such as `ai-vlm.service`.

## Webdisk

| Item | Value |
| --- | --- |
| Public URL | `http://60.205.213.254:2233` |
| Public port | `2233/tcp` on cloud `frps` |
| Windows local port | `127.0.0.1:2233` |
| Windows File Browser task | `CZCloudDrive` |
| Windows webdisk frpc task | `CZCloudDriveFrpc` |
| Workspace sync task | `CZCloudDriveWorkspaceSync` |
| Install dir | `C:\CZCloudDrive` |
| Data dir | `C:\CZCloudDrive\data` |

The webdisk deployment is documented in `docs/webdisk/`. The reproducible entry
point is `scripts/unix/deploy-webdisk-webpage.sh`, which builds the custom File
Browser web UI and binary, uploads it to Windows, installs File Browser, starts
the 2233 frpc task, and verifies the public endpoint. The lower-level helper is
`scripts/unix/deploy-filebrowser-drive-remote.sh`.
