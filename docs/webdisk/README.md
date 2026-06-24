# Web Disk Deployment Notes

Status: investigation-only

This document records the current web disk evidence and the safe checks needed
before claiming a completed deployment. It is intentionally generic: public
ports such as `2233` are evidence points, not the document identity.

## Current Conclusion

The web disk deployment is not yet documented well enough to reproduce or
operate safely.

Known evidence:

| Endpoint | Current observation | Interpretation |
| --- | --- | --- |
| `60.205.213.254:2233` | TCP reachable, but direct HTTP returns an empty reply and HTTPS fails during TLS setup | A public listener exists, but the active backend is unconfirmed |
| `192.168.100.12:80` | Historical note described an Apache/Nextcloud-style page | Likely a separate internal web service clue, not proof for the public endpoint |

A prior local investigation note outside this repository associated public port
`2233` with a Windows-side `filebrowser.exe` process. Current public probes did
not independently confirm File Browser, Nextcloud, or Apache as the active
backend.

## Evidence Collected

Repository search before this document and the non-webdisk operations inventory
were added did not find an existing web disk deployment document, script, or
configuration.

Command:

```bash
rg -n -i "web[ -]?disk|webdisk|2233|filebrowser|file browser|nextcloud|apache|60\.205\.213\.254|192\.168\.100\.12" README.md docs scripts examples
```

Reduced findings:

```text
examples/frp/frpc.example.toml:1:serverAddr = "60.205.213.254"
scripts/windows/setup-frpc.ps1:16:    [string]$ServerAddr = "60.205.213.254",
docs/frp/windows-client-deployment-guide.md:15:- 公网 IP：`60.205.213.254`
docs/frp/windows-client-deployment-guide.md:22:- frpc 连接 ECS：`60.205.213.254:7000`
docs/frp/windows-client-deployment-guide.md:29:  -> 60.205.213.254:2222
docs/ai-stack/current-deployment.md:8:ssh -p 2222 admin@60.205.213.254
docs/ai-stack/current-deployment.md:9:ssh ubuntu@192.168.100.12
scripts/ai-stack/smoke-qwen36.sh:4:HOST="${AI_BIND_HOST:-192.168.100.12}"
```

Public endpoint probes against `60.205.213.254:2233`:

```bash
nc -vz -w 5 60.205.213.254 2233
curl --noproxy '*' -sS -I --max-time 10 http://60.205.213.254:2233/
curl --noproxy '*' -k -sS -I --max-time 10 https://60.205.213.254:2233/
```

Observed result:

```text
TCP connect succeeded.
HTTP returned: curl: (52) Empty reply from server
HTTPS returned: LibreSSL SSL_connect: SSL_ERROR_SYSCALL
```

The local shell had proxy environment variables set, so direct probes used
`--noproxy '*'`. A proxied `curl` returned `HTTP/1.1 503 Service Unavailable`,
which is not reliable evidence for the target service itself.

## Deployment Hypotheses

These are hypotheses only. Do not treat any of them as the current deployment
until they are verified from the relevant host.

| Hypothesis | Supporting clue | Missing proof |
| --- | --- | --- |
| Windows File Browser exposed through FRP | Prior note associated `2233` with `filebrowser.exe`; the repo already documents the ECS/frp pattern for SSH | Current Windows process list, frpc proxy config, data directory, auth config |
| Internal Nextcloud/Apache service | Prior note saw an Apache/Nextcloud-style page on `192.168.100.12:80` | Current internal HTTP response and whether it is related to public web disk access |
| Dead or miswired public listener | Public TCP accepts but HTTP/HTTPS do not identify a web app | ECS frps logs, `allowPorts`, and active frpc registration |

## What Is Not Yet Complete

- No reproducible web disk deployment script is present.
- No confirmed service manager entry is documented for File Browser, Nextcloud,
  Apache, or another web disk backend.
- No confirmed data directory, user/auth configuration, backup procedure, or
  rollback process is recorded.
- No confirmed autostart path exists for the web disk service.
- No confirmed public access path exists beyond the current TCP listener.

## Safe Next Checks

Keep these checks read-only until the backend and data location are understood.

On the ECS/frps host:

```bash
ss -tlnp | grep -E '(:7000|:2222|:2233)([[:space:]]|$)' || true
grep -R "2233" /etc/frp /etc/systemd/system /usr/local/etc 2>/dev/null || true
journalctl -u frps -n 120 --no-pager
```

On the Windows/frpc host reached through the documented SSH path:

```powershell
netstat -ano | findstr ":2233"
Get-Process | Where-Object { $_.ProcessName -match "filebrowser|frpc" } | Select-Object Id,ProcessName,Path
Get-CimInstance Win32_Process | Where-Object { $_.Name -match "filebrowser|frpc" } | Select-Object Name,ProcessId,CommandLine
Get-ChildItem -Path C:\ -Filter "*filebrowser*" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 50 FullName
```

For the separate internal Nextcloud/Apache clue:

```bash
curl -I --max-time 10 http://192.168.100.12/
curl -sS --max-time 10 http://192.168.100.12/ | sed -n '1,40p'
```

Do not attempt logins, credential resets, service restarts, config edits, or a
new web disk deployment until these read-only checks identify the active
backend and data path.
