# Hermes Agent Platform Deployment Guide

This guide deploys the MVP described in
`docs/agent-platform/hermes-agent-platform-design.md`.

Current validation evidence and deployment gaps are tracked in
`docs/agent-platform/validation-status.md`.

## Runtime Secrets

Do not commit these values:

- `AI_API_KEY`
- `FRPS_AUTH_TOKEN`
- chat platform credentials
- generated `frpc.toml` or `frps.toml`
- `apps/ui/data/state.json`
- `apps/ui/runtime/*.env`
- `agent-platform/runtime/*`

## Local Windows Web App

Run from the repository root on the Windows AI host:

```powershell
$env:AI_API_KEY = "<runtime-secret>"
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-agent-platform.ps1 `
  -BootstrapAdminPassword "<initial-admin-password>" `
  -DockerManagerMode real `
  -NodeExe "C:\Users\chuan\node-portable\node.exe" `
  -RegisterScheduledTask `
  -ScheduledTaskTrigger AtLogon
```

Omit `-NodeExe` when Node.js is already on `PATH`. Keep it when Node.js is not on `PATH` and the host uses a portable runtime.

The app listens on:

```text
http://127.0.0.1:3080/
```

Runtime state is written under:

```text
C:\ProgramData\CZ-CloudService\agent-platform\
```

When registering the Scheduled Task in `real` mode, the setup script reads
`AI_API_KEY` from the current PowerShell environment and carries it into the
generated `start-agent-platform.cmd`. Treat that generated launcher as a
runtime secret file and do not copy it into Git.

Use `-ScheduledTaskTrigger AtStartup` from elevated PowerShell when the web app
must start before an operator logs in. That mode registers a SYSTEM task, so the
repository path, Node.js binary, and generated launcher must be readable by
SYSTEM.

## Hermes Image Contract

If the upstream Hermes image already exposes the required `hermes-profilectl`
contract, use that image directly. If it does not, build the repository wrapper
image first:

```bash
docker build -t hermes:latest agent-platform/hermes-wrapper
```

The wrapper image installs a file-backed `hermes-profilectl` shim that stores
profile records under `/data` and enforces the private model environment
contract. It is meant to satisfy the Phase 0 profile-control surface while the
real Hermes runtime is packaged behind the same contract.

Before using real employee containers, verify the standard image contract:

```bash
AI_API_KEY="<runtime-secret>" \
HERMES_IMAGE="hermes:latest" \
bash agent-platform/hermes-contract-smoke.sh
```

The smoke script checks:

- `hermes-profilectl` is on `PATH`
- Docker socket is not exposed inside the container
- private model settings are injected through a temporary env file
- `hermes-profilectl health --json` returns ready private model metadata
- idempotent profile create through stdin
- `list --json`
- profile start/restart/stop/delete
- idempotent delete for a missing profile
- no API key in the captured command outputs

## FRP Server

On the cloud ECS host, preserve the managed SSH, web, and LLM ports:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" \
  bash scripts/cloud/setup-frps.sh --allow-ports 2222,2444,9000 --apply
bash scripts/cloud/check-frps-agent-platform.sh
```

Cloud security group inbound rules should restrict `2444/tcp` and `9000/tcp` to
operator or company source IPs where possible.

## Windows FRP Client

Use one `frpc.toml` with SSH, web, and LLM proxy blocks:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<runtime-token>" `
  -RegisterScheduledTask `
  -ScheduledTaskTrigger AtLogon
```

The script writes:

```toml
[[proxies]]
name = "windows-ssh-2222"
localPort = 22222
remotePort = 2222

[[proxies]]
name = "hermes-agent-web-2444"
localPort = 3080
remotePort = 2444

[[proxies]]
name = "ai-llm-qwen36-9000"
localIP = "192.168.100.12"
localPort = 8000
remotePort = 9000
```

## Verification

From the repository root, run the repeatable local acceptance gate:

```bash
bash agent-platform/local-acceptance.sh
```

To include public FRP TCP/HTTP smoke from the current operator machine:

```bash
RUN_PUBLIC_SMOKE=1 bash agent-platform/local-acceptance.sh
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\check-agent-platform.ps1
Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing
Get-Process frpc -ErrorAction SilentlyContinue
docker ps
```

The Windows diagnostic script reports the local web app, `frpc`, Scheduled
Tasks, Docker CLI, Docker service candidates, and the generated
`start-agent-platform.cmd` `DOCKER_MANAGER_MODE` value. A healthy web/FRP path
is not enough for final acceptance if Docker is missing or the launcher still
uses `dry-run`.

On the cloud ECS host:

```bash
bash scripts/cloud/check-frps-agent-platform.sh
systemctl is-active frps
ss -tlnp | grep -E '(:7000|:2222|:2444|:9000)([[:space:]]|$)'
tail -n 80 /var/log/frps.log
```

From an allowed operator machine:

```bash
curl --noproxy '*' -i http://60.205.213.254:2444/
```

Expected:

- HTTP `200`
- page contains `Hermes Agent 管理平台`

If TCP connects but HTTP returns `Empty reply from server`, the cloud port is
open but the upstream tunnel is not serving the web app yet. Run the Windows
diagnostic script first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\check-agent-platform.ps1
```

Then check the ECS `frps` log for the `hermes-agent-web-2444` proxy registration.
The cloud helper prints the same listener, allowPorts, and proxy-log checks:

```bash
bash scripts/cloud/check-frps-agent-platform.sh
```

If ECS shows only `7000` and no `2222`, `2444`, or `9000` listener, the Windows
`frpc` client is not logged in to `frps`. Start it again from the Windows host:

```powershell
$frp = "C:\Users\chuan\todesk-ssh"
& "$frp\frp_0.69.1_windows_amd64\frpc.exe" verify -c "$frp\frpc.toml"
Start-Process -FilePath "$frp\frp_0.69.1_windows_amd64\frpc.exe" `
  -ArgumentList "-c", "$frp\frpc.toml" `
  -WindowStyle Hidden
Get-Process frpc
Start-ScheduledTask -TaskName "CZ Hermes Agent Platform"
```

When updating `frpc.toml` through the same `2222` FRP SSH tunnel, do not stop the
current `frpc` process inline. Use the setup script's detached restart mode so
the SSH command can return before the old tunnel is stopped:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-frpc.ps1 `
  -AuthToken "<runtime-token>" `
  -SkipLocalPortCheck `
  -CheckLlmPort `
  -RestartExistingDetached
```
