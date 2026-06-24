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
| Ports | `7000/tcp` control, `2222/tcp` public SSH proxy |
| Allow list | `allowPorts = [{ start = 2222, end = 2222 }]` by default |

Notes:

- `7000/tcp` must be reachable from the Windows `frpc` client.
- `2222/tcp` should be restricted to operator source IPs in the cloud security
  group where possible.
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
| Ports | Connects to cloud `7000/tcp`; registers cloud `2222/tcp`; forwards to local `127.0.0.1:22222` |

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

## AI Services

| Service | Port | Expected autostart | Current role |
| --- | --- | --- | --- |
| `ai-llm.service` | `8000` | enabled | Qwen3.6 FP8 LLM and multimodal endpoint |
| `ai-vlm.service` | `8001` | disabled | Old Qwen2.5-VL endpoint, intentionally inactive |
| `ai-speech.service` | `8002` | enabled | SenseVoiceSmall speech recognition |
| `ai-comfy.service` | `8188` | enabled | Primary ComfyUI instance |
| `ai-comfy-gpu2.service` | `8189` | enabled | Secondary ComfyUI instance |

Rollback safety:

- `scripts/ai-stack/rollback-ai-stack-backup.sh --apply` restores files and
  restarts only services that are currently enabled.
- Use `--restart-disabled` only when intentionally reviving a disabled service
  such as `ai-vlm.service`.

## Webdisk

Webdisk deployment is investigation-only and out of scope for this completion
pass. This document does not claim a completed webdisk port, autostart path, or
deployment script. See `docs/webdisk/README.md` for the generic investigation
notes and safe next checks.
