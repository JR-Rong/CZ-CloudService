# Cloud frps Server Deployment Guide

This guide covers the Ubuntu/systemd `frps` side of the current FRP tunnel.
It intentionally uses placeholders and runtime token input only.

## Target Architecture

```text
external ssh client -> cloud ECS:2222 -> frps -> Windows frpc -> 127.0.0.1:22222 sshd
```

Required cloud listeners:

| Port | Owner | Purpose |
| --- | --- | --- |
| `7000/tcp` | `frps` | FRP control connection from Windows `frpc` |
| `2222/tcp` | `frps` | Public SSH proxy registered by Windows `frpc` |

`2222` appears only after the Windows client connects and registers the proxy.

## Safe Inputs

Use a generated token at runtime. Do not paste the real token into this repo,
docs, chats, shell scripts, or examples.

Preferred apply command on the ECS host:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" bash scripts/cloud/setup-frps.sh --apply
```

For less shell-history exposure, read the token interactively into a shell
variable, write it to a root-only temp file, and remove it after deployment:

```bash
read -r -s -p 'FRP auth token: ' FRPS_TOKEN
echo
sudo install -m 0600 /dev/null /root/frps-token.txt
printf '%s\n' "$FRPS_TOKEN" | sudo tee /root/frps-token.txt >/dev/null
unset FRPS_TOKEN
sudo bash scripts/cloud/setup-frps.sh --token-file /root/frps-token.txt --apply
sudo rm -f /root/frps-token.txt
```

Dry-run is the default and does not require a real token:

```bash
bash scripts/cloud/setup-frps.sh
```

## Install and Autostart

The script installs or reuses `frps` `0.69.1`, writes `/etc/frp/frps.toml`,
writes `/etc/systemd/system/frps.service`, then enables and starts the service
only when `--apply` is present.

Default generated service:

```ini
[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
```

Default generated FRPS config matches `examples/frp/frps.example.toml`:

```toml
bindPort = 7000

auth.method = "token"
auth.token = "<runtime-token>"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]

transport.tls.force = true
transport.tcpMux = false

allowPorts = [
  { start = 2222, end = 2222 }
]
```

To allow an additional Windows client, choose a different remote port and update
both `allowPorts` and the cloud security group:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" \
  bash scripts/cloud/setup-frps.sh --allow-ports 2222,2223 --apply
```

## Cloud Security Group

Minimum inbound rules:

| Port | Source | Notes |
| --- | --- | --- |
| `7000/tcp` | Windows client public IP, or restricted operator IP range | Required for `frpc` control connection |
| `2222/tcp` | Operator public IP `/32` when possible | Public SSH proxy |

Avoid leaving `2222/tcp` open to `0.0.0.0/0`. FRP plus SSH looks similar to a
reverse-shell pattern to cloud security products, so keep the source CIDRs
narrow and rotate the token if it was exposed.

## Verification

Run on the cloud host after apply:

```bash
systemctl is-enabled frps
systemctl is-active frps
/usr/local/bin/frps --version
ss -tlnp | grep -E '(:7000|:2222)([[:space:]]|$)' || true
journalctl -u frps.service -n 80 --no-pager
```

Expected before Windows `frpc` connects:

```text
enabled
active
0.69.1
*:7000  frps
```

Expected after Windows `frpc` connects and registers `remotePort = 2222`:

```text
*:7000  frps
*:2222  frps
```

End-to-end check from an external machine:

```bash
ssh -p 2222 admin@<cloud-public-ip> hostname
```

## Restart and Rollback

Restart without changing files:

```bash
sudo systemctl restart frps.service
sudo journalctl -u frps.service -n 80 --no-pager
```

Disable autostart and stop FRPS:

```bash
sudo systemctl disable --now frps.service
```

Rollback to a previous copied config:

```bash
sudo install -m 0600 /path/to/frps.toml.backup /etc/frp/frps.toml
sudo systemctl restart frps.service
```

Remove the managed service and binary only when intentionally decommissioning:

```bash
sudo systemctl disable --now frps.service
sudo rm -f /etc/systemd/system/frps.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/frps
```

## Secret Handling

- Keep real `auth.token` values out of Git, docs, shell history, screenshots,
  and issue comments.
- Commit only placeholder examples such as `examples/frp/frps.example.toml`.
- Use `FRPS_AUTH_TOKEN`, `--token-file`, or the script's interactive prompt at
  deployment time.
- If a token was exposed, replace it in both `/etc/frp/frps.toml` and Windows
  `frpc.toml`, then restart `frps` and `frpc`.
