#!/usr/bin/env bash
set -euo pipefail

SCRIPT_VERSION="2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="${CZ_SAFETY_ROOT:-/}"
ACTION=""
CONFIG_PATH=""
PEER_NAME=""
PEER_ROLE=""
CONFIRM_CONSOLE="no"
CONFIRM_EXTERNAL="no"
BACKUP_ID=""
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  deploy-ubuntu-direct.sh <action> --config PATH [options]

Actions:
  preflight       Read-only target and configuration checks.
  plan            Render the managed configuration without writing it.
  self-test       Run platform-neutral offline contract tests.
  prepare-bundle  Download Ubuntu packages into --output-dir (Ubuntu 24.04 only).
  apply           Apply on Ubuntu 24.04; requires --confirm-console.
  verify          Run live checks and write an acceptance report.
  confirm         Cancel the pending automatic rollback.
  rollback        Restore a backup; optionally pass --backup-id.
  peer-add        Add a WireGuard peer; requires --name and --role.
  peer-revoke     Revoke a WireGuard peer; requires --name.
  evidence        Collect a redacted evidence bundle.

Options:
  --config PATH           Site config (required except self-test).
  --name NAME             Peer name for peer-add/peer-revoke.
  --role admin|employee   Peer role for peer-add.
  --confirm-console       Confirm that local console recovery is available.
  --confirm-external      Confirm that an external admin VPN/SSH test passed.
  --backup-id ID          Backup identifier for rollback.
  --output-dir PATH       Package/evidence output directory.
  -h, --help              Show this help.

Mutating actions never read secrets from the repository. Runtime keys are kept
under /etc/cz-safety/secrets and exported client configs contain private keys.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

info() {
  printf '[cz-safety] %s\n' "$*"
}

target_path() {
  local path="$1"
  if [ "$TARGET_ROOT" = "/" ]; then
    printf '%s\n' "$path"
  else
    printf '%s%s\n' "${TARGET_ROOT%/}" "$path"
  fi
}

is_live_root() {
  [ "$TARGET_ROOT" = "/" ]
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

set_defaults() {
  WAN_INTERFACE=""
  WAN_CIDR=""
  WAN_GATEWAY=""
  DNS_SERVERS="1.1.1.1,9.9.9.9"
  WIREGUARD_INTERFACE="wg0"
  WIREGUARD_ADDRESS="10.203.0.1/24"
  WIREGUARD_PORT="51820"
  ADMIN_VPN_CIDR="10.203.0.0/26"
  EMPLOYEE_VPN_CIDR="10.203.0.128/25"
  BMC_MODE="auto"
  BMC_INTERFACE=""
  BMC_GATEWAY_CIDR="192.168.100.1/24"
  BMC_ADDRESS="192.168.100.10"
  BMC_WEB_PORT="443"
  SSH_PORT="22"
  SSH_ADMIN_GROUP="safety-admin"
  SSH_ADMIN_USER="safetyops"
  SSH_ADMIN_PUBLIC_KEY_FILE="/root/cz-safety/admin_authorized_keys"
  HTTPS_PORT="443"
  ENABLE_HTTPS="no"
  TLS_CERT_PATH="/etc/cz-safety/tls/server.crt"
  TLS_KEY_PATH="/etc/cz-safety/tls/server.key"
  HTTPS_UPSTREAM="http://127.0.0.1:8080"
  EGRESS_MODE="strict"
  PACKAGE_MODE="skip"
  ROLLBACK_MINUTES="20"
}

is_allowed_config_key() {
  case "$1" in
    WAN_INTERFACE|WAN_CIDR|WAN_GATEWAY|DNS_SERVERS|WIREGUARD_INTERFACE|WIREGUARD_ADDRESS|WIREGUARD_PORT|ADMIN_VPN_CIDR|EMPLOYEE_VPN_CIDR|BMC_MODE|BMC_INTERFACE|BMC_GATEWAY_CIDR|BMC_ADDRESS|BMC_WEB_PORT|SSH_PORT|SSH_ADMIN_GROUP|SSH_ADMIN_USER|SSH_ADMIN_PUBLIC_KEY_FILE|HTTPS_PORT|ENABLE_HTTPS|TLS_CERT_PATH|TLS_KEY_PATH|HTTPS_UPSTREAM|EGRESS_MODE|PACKAGE_MODE|ROLLBACK_MINUTES) return 0 ;;
    *) return 1 ;;
  esac
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_config() {
  local line key value
  [ -f "$CONFIG_PATH" ] || die "Config not found: $CONFIG_PATH"
  set_defaults
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in *=*) ;; *) die "Invalid config line (expected KEY=VALUE): $line" ;; esac
    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Invalid config key: $key"
    is_allowed_config_key "$key" || die "Unknown config key: $key"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    case "$value" in *'$('*|*'`'*|*';'*|*'${'*) die "Unsafe value for $key" ;; esac
    printf -v "$key" '%s' "$value"
  done < "$CONFIG_PATH"
}

validate_config() {
  require_command python3
  [ -n "$WAN_INTERFACE" ] || die "WAN_INTERFACE is required"
  [ -n "$WAN_CIDR" ] || die "WAN_CIDR is required"
  [ -n "$WAN_GATEWAY" ] || die "WAN_GATEWAY is required"
  case "$BMC_MODE" in auto|disabled|routed|snat) ;; *) die "BMC_MODE must be auto, disabled, routed, or snat" ;; esac
  case "$ENABLE_HTTPS" in yes|no) ;; *) die "ENABLE_HTTPS must be yes or no" ;; esac
  case "$EGRESS_MODE" in staged|strict|audit) ;; *) die "EGRESS_MODE must be staged, strict, or audit" ;; esac
  case "$PACKAGE_MODE" in skip|online|offline) ;; *) die "PACKAGE_MODE must be skip, online, or offline" ;; esac
  [[ "$WIREGUARD_PORT" =~ ^[0-9]+$ ]] || die "WIREGUARD_PORT must be numeric"
  [ "$WIREGUARD_PORT" -ge 1 ] && [ "$WIREGUARD_PORT" -le 65535 ] || die "WIREGUARD_PORT is out of range"
  [[ "$BMC_WEB_PORT" =~ ^[0-9]+$ ]] || die "BMC_WEB_PORT must be numeric"
  [ "$BMC_WEB_PORT" -ge 1 ] && [ "$BMC_WEB_PORT" -le 65535 ] || die "BMC_WEB_PORT is out of range"
  [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || die "SSH_PORT must be numeric"
  [[ "$HTTPS_PORT" =~ ^[0-9]+$ ]] || die "HTTPS_PORT must be numeric"
  [[ "$ROLLBACK_MINUTES" =~ ^[0-9]+$ ]] || die "ROLLBACK_MINUTES must be numeric"
  [ "$SSH_PORT" -ge 1 ] && [ "$SSH_PORT" -le 65535 ] || die "SSH_PORT is out of range"
  [ "$HTTPS_PORT" -ge 1 ] && [ "$HTTPS_PORT" -le 65535 ] || die "HTTPS_PORT is out of range"
  [ "$ROLLBACK_MINUTES" -ge 5 ] && [ "$ROLLBACK_MINUTES" -le 60 ] || die "ROLLBACK_MINUTES must be between 5 and 60"
  [[ "$WAN_INTERFACE" =~ ^[a-zA-Z0-9_.:-]{1,15}$ ]] || die "WAN_INTERFACE is invalid"
  [[ "$WIREGUARD_INTERFACE" =~ ^[a-zA-Z0-9_.:-]{1,15}$ ]] || die "WIREGUARD_INTERFACE is invalid"
  if [ -n "$BMC_INTERFACE" ]; then
    [[ "$BMC_INTERFACE" =~ ^[a-zA-Z0-9_.:-]{1,15}$ ]] || die "BMC_INTERFACE is invalid"
  fi
  [[ "$SSH_ADMIN_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "SSH_ADMIN_GROUP is invalid"
  [[ "$SSH_ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "SSH_ADMIN_USER is invalid"
  [[ "$SSH_ADMIN_PUBLIC_KEY_FILE" = /* ]] || die "SSH_ADMIN_PUBLIC_KEY_FILE must be an absolute path"
  [ "$BMC_ADDRESS" = "192.168.100.10" ] || die "BMC_ADDRESS must remain 192.168.100.10"
  if [ "$BMC_MODE" != "disabled" ] && [ -z "$BMC_INTERFACE" ] && [ "$BMC_MODE" != "auto" ]; then
    die "BMC_INTERFACE is required when BMC_MODE=$BMC_MODE"
  fi
  if [ -n "$BMC_INTERFACE" ] && [ "$BMC_INTERFACE" = "$WAN_INTERFACE" ]; then
    die "WAN_INTERFACE and BMC_INTERFACE must be different"
  fi

  python3 - "$WAN_CIDR" "$WAN_GATEWAY" "$WIREGUARD_ADDRESS" "$ADMIN_VPN_CIDR" "$EMPLOYEE_VPN_CIDR" "$BMC_GATEWAY_CIDR" "$BMC_ADDRESS" <<'PY'
import ipaddress
import sys

wan_if = ipaddress.ip_interface(sys.argv[1])
gateway = ipaddress.ip_address(sys.argv[2])
wg_if = ipaddress.ip_interface(sys.argv[3])
admin = ipaddress.ip_network(sys.argv[4], strict=False)
employee = ipaddress.ip_network(sys.argv[5], strict=False)
bmc_if = ipaddress.ip_interface(sys.argv[6])
bmc = ipaddress.ip_address(sys.argv[7])

if wan_if.version != 4 or wan_if.network.prefixlen != 30:
    raise SystemExit("WAN_CIDR must be an IPv4 /30")
hosts = list(wan_if.network.hosts())
if gateway != hosts[0]:
    raise SystemExit(f"WAN_GATEWAY must be the first usable address ({hosts[0]})")
if wan_if.ip != hosts[1]:
    raise SystemExit(f"WAN_CIDR must use the second usable address ({hosts[1]})")
if wan_if.ip.packed[-1] != 106 or gateway.packed[-1] != 105:
    raise SystemExit("The assigned /30 must use .105 as gateway and .106 as host")
if wg_if.ip not in admin:
    raise SystemExit("WIREGUARD_ADDRESS must fall inside ADMIN_VPN_CIDR")
if not admin.subnet_of(wg_if.network) or not employee.subnet_of(wg_if.network):
    raise SystemExit("Admin and employee VPN ranges must be inside the WireGuard network")
if admin.overlaps(employee):
    raise SystemExit("ADMIN_VPN_CIDR and EMPLOYEE_VPN_CIDR overlap")
if bmc != ipaddress.ip_address("192.168.100.10"):
    raise SystemExit("BMC address changed unexpectedly")
if bmc not in bmc_if.network:
    raise SystemExit("BMC_ADDRESS is not in BMC_GATEWAY_CIDR")
for left, right, label in [
    (wan_if.network, wg_if.network, "WAN/WireGuard"),
    (wan_if.network, bmc_if.network, "WAN/BMC"),
    (wg_if.network, bmc_if.network, "WireGuard/BMC"),
]:
    if left.overlaps(right):
        raise SystemExit(f"{label} networks overlap")
PY
}

is_example_wan() {
  python3 - "$WAN_CIDR" <<'PY'
import ipaddress, sys
ip = ipaddress.ip_interface(sys.argv[1]).ip
blocks = [
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
]
raise SystemExit(0 if any(ip in block for block in blocks) else 1)
PY
}

csv_to_nft_set() {
  local csv="$1"
  if [ -z "$csv" ]; then
    printf ' '
  else
    printf '%s' "$csv" | tr ',' '\n' | awk 'NF {gsub(/[[:space:]]/, ""); printf "%s%s", sep, $0; sep=", "}'
  fi
}

peers_file() {
  target_path "/etc/cz-safety/peers.tsv"
}

peer_addresses() {
  local role="$1" file
  file="$(peers_file)"
  if [ -f "$file" ]; then
    awk -F '\t' -v wanted="$role" '$2 == wanted {print $3}' "$file" | paste -sd, -
  fi
}

resolved_bmc_mode() {
  if [ "$BMC_MODE" = "auto" ]; then
    if [ -z "$BMC_INTERFACE" ]; then
      printf 'disabled\n'
    elif is_live_root && command -v ip >/dev/null 2>&1 && ! ip link show "$BMC_INTERFACE" >/dev/null 2>&1; then
      printf 'disabled\n'
    else
      printf 'routed\n'
    fi
  else
    printf '%s\n' "$BMC_MODE"
  fi
}

render_netplan() {
  local dns_yaml
  dns_yaml="$(printf '%s' "$DNS_SERVERS" | awk -F, '{for(i=1;i<=NF;i++){gsub(/[[:space:]]/,"",$i); printf "%s%s", sep, $i; sep=", "}}')"
  cat <<EOF
network:
  version: 2
  ethernets:
    ${WAN_INTERFACE}:
      dhcp4: false
      dhcp6: false
      addresses: [${WAN_CIDR}]
      routes:
        - to: default
          via: ${WAN_GATEWAY}
      nameservers:
        addresses: [${dns_yaml}]
EOF
  if [ "$(resolved_bmc_mode)" != "disabled" ]; then
    cat <<EOF
    ${BMC_INTERFACE}:
      dhcp4: false
      dhcp6: false
      addresses: [${BMC_GATEWAY_CIDR}]
      optional: true
EOF
  fi
}

render_wireguard() {
  local private_key_file peer_dir peer_file
  private_key_file="$(target_path /etc/cz-safety/secrets/wg-server.key)"
  cat <<EOF
[Interface]
Address = ${WIREGUARD_ADDRESS}
ListenPort = ${WIREGUARD_PORT}
PrivateKey = $(if [ -f "$private_key_file" ]; then sed -n '1p' "$private_key_file"; else printf '<runtime-server-private-key>'; fi)
SaveConfig = false
EOF
  peer_dir="$(target_path /etc/cz-safety/peers.d)"
  if [ -d "$peer_dir" ]; then
    for peer_file in "$peer_dir"/*.server.conf; do
      [ -f "$peer_file" ] || continue
      printf '\n'
      sed -n '/^\[Peer\]/,$p' "$peer_file"
    done
  fi
}

render_nftables() {
  local admins employees bmc_mode output_policy udp_ports
  admins="$(csv_to_nft_set "$(peer_addresses admin)")"
  employees="$(csv_to_nft_set "$(peer_addresses employee)")"
  bmc_mode="$(resolved_bmc_mode)"
  output_policy="drop"
  [ "$EGRESS_MODE" = "audit" ] && output_policy="accept"
  udp_ports="53, 123"
  [ "$EGRESS_MODE" = "staged" ] && udp_ports="53, 123, 443"
  cat <<EOF
#!/usr/sbin/nft -f
flush ruleset

table inet cz_safety {
  set admin_peers {
    type ipv4_addr
    elements = {${admins}}
  }

  set employee_peers {
    type ipv4_addr
    elements = {${employees}}
  }

  chain input {
    type filter hook input priority filter; policy drop;
    ct state invalid drop
    ct state established,related accept
    iifname "lo" accept
    ip protocol icmp limit rate 20/second accept
    iifname "${WAN_INTERFACE}" udp dport ${WIREGUARD_PORT} accept
    iifname "${WIREGUARD_INTERFACE}" ip saddr @admin_peers tcp dport { ${SSH_PORT}, ${HTTPS_PORT} } accept
    iifname "${WIREGUARD_INTERFACE}" ip saddr @employee_peers tcp dport ${HTTPS_PORT} accept
    limit rate 10/second log prefix "CZ-SAFETY-DROP " level info
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state invalid drop
    ct state established,related accept
EOF
  if [ "$bmc_mode" != "disabled" ]; then
    cat <<EOF
    iifname "${WIREGUARD_INTERFACE}" oifname "${BMC_INTERFACE}" ip saddr @admin_peers ip daddr ${BMC_ADDRESS} tcp dport ${BMC_WEB_PORT} accept
EOF
  fi
  cat <<EOF
    limit rate 10/second log prefix "CZ-SAFETY-FWD-DROP " level info
  }

  chain output {
    type filter hook output priority filter; policy ${output_policy};
EOF
  if [ "$output_policy" = "drop" ]; then
    cat <<EOF
    ct state invalid drop
    ct state established,related accept
    oifname "lo" accept
    ip protocol icmp accept
    udp dport { ${udp_ports} } accept
    tcp dport { 53, 80, 443 } accept
EOF
  fi
  cat <<'EOF'
  }
}
EOF

  if [ "$bmc_mode" = "snat" ]; then
    cat <<EOF

table ip cz_safety_nat {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    iifname "${WIREGUARD_INTERFACE}" oifname "${BMC_INTERFACE}" ip saddr ${ADMIN_VPN_CIDR} ip daddr ${BMC_ADDRESS} snat to ${BMC_GATEWAY_CIDR%/*}
  }
}
EOF
  fi
}

render_sshd_dropin() {
  cat <<EOF
# Managed by CZ Safety. Network reachability is enforced by nftables.
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowGroups ${SSH_ADMIN_GROUP}
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
GatewayPorts no
PermitTunnel no
EOF
}

render_sysctl() {
  cat <<EOF
net.ipv4.ip_forward=1
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.default.send_redirects=0
net.ipv4.conf.all.accept_source_route=0
net.ipv4.conf.default.accept_source_route=0
net.ipv4.conf.${WAN_INTERFACE}.rp_filter=1
net.ipv4.tcp_syncookies=1
net.ipv6.conf.all.accept_redirects=0
net.ipv6.conf.default.accept_redirects=0
net.ipv6.conf.${WAN_INTERFACE}.disable_ipv6=1
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
fs.protected_hardlinks=1
fs.protected_symlinks=1
EOF
}

render_audit_rules() {
  cat <<'EOF'
-w /etc/cz-safety/ -p wa -k cz_safety
-w /etc/wireguard/ -p wa -k cz_wireguard
-w /etc/nftables.conf -p wa -k cz_firewall
-w /etc/ssh/sshd_config -p wa -k cz_sshd
-w /etc/ssh/sshd_config.d/ -p wa -k cz_sshd
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/sudoers -p wa -k privilege
-w /etc/sudoers.d/ -p wa -k privilege
EOF
}

render_nginx() {
  cat <<EOF
server {
    listen ${WIREGUARD_ADDRESS%/*}:${HTTPS_PORT} ssl;
    server_name _;
    ssl_certificate ${TLS_CERT_PATH};
    ssl_certificate_key ${TLS_KEY_PATH};
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    location = /cz-safety-health {
        default_type text/plain;
        return 200 "ok\\n";
    }
    location / {
        proxy_pass ${HTTPS_UPSTREAM};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
}

print_plan() {
  validate_config
  printf '%s\n' '=== NETPLAN ==='
  render_netplan
  printf '%s\n' '=== NFTABLES ==='
  render_nftables
  printf '%s\n' '=== SSHD DROP-IN ==='
  render_sshd_dropin
  printf '%s\n' '=== SYSCTL ==='
  render_sysctl
  printf '%s\n' '=== AUDIT RULES ==='
  render_audit_rules
  printf '%s\n' '=== WIREGUARD (PRIVATE KEY REDACTED) ==='
  render_wireguard | sed -E 's/^(PrivateKey|PresharedKey) = .*/\1 = <redacted>/'
  if [ "$ENABLE_HTTPS" = "yes" ]; then
    printf '%s\n' '=== NGINX ==='
    render_nginx
  fi
}

platform_status() {
  if [ "$(uname -s)" != "Linux" ]; then
    printf 'PENDING_UBUNTU_SITE\n'
    return
  fi
  if [ ! -f /etc/os-release ]; then
    printf 'BLOCKED\n'
    return
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${VERSION_ID:-}" = "24.04" ]; then
    printf 'PASS\n'
  else
    printf 'BLOCKED\n'
  fi
}

is_target_ubuntu() {
  is_live_root && [ "$(platform_status)" = "PASS" ]
}

preflight() {
  local status missing="" missing_artifacts="" command_name bmc_status
  validate_config
  status="$(platform_status)"
  for command_name in python3; do
    command -v "$command_name" >/dev/null 2>&1 || missing="$missing $command_name"
  done
  if [ "$status" = "PASS" ]; then
    command -v ip >/dev/null 2>&1 && ip link show "$WAN_INTERFACE" >/dev/null 2>&1 || missing_artifacts="$missing_artifacts adapter:$WAN_INTERFACE"
    [ -f "$SSH_ADMIN_PUBLIC_KEY_FILE" ] || missing_artifacts="$missing_artifacts $SSH_ADMIN_PUBLIC_KEY_FILE"
    if [ "$PACKAGE_MODE" = "skip" ]; then
      for command_name in nft wg wg-quick sshd netplan systemctl augenrules; do
        command -v "$command_name" >/dev/null 2>&1 || missing="$missing $command_name"
      done
    elif [ "$PACKAGE_MODE" = "offline" ] && [ ! -d "$(dirname "$CONFIG_PATH")/offline-debs" ]; then
      missing_artifacts="$missing_artifacts offline-debs"
    fi
    if [ -n "$(trim "$missing $missing_artifacts")" ]; then status="BLOCKED"; fi
  fi
  bmc_status="disabled"
  if [ "$(resolved_bmc_mode)" != "disabled" ]; then
    bmc_status="pending-link-check"
    if [ "$(uname -s)" = "Linux" ] && command -v ip >/dev/null 2>&1 && ip link show "$BMC_INTERFACE" >/dev/null 2>&1; then
      bmc_status="interface-present"
    fi
  fi
  cat <<EOF
{
  "script": "deploy-ubuntu-direct.sh",
  "scriptVersion": "${SCRIPT_VERSION}",
  "status": "${status}",
  "wanInterface": "${WAN_INTERFACE}",
  "wanCidr": "${WAN_CIDR}",
  "wireguardPort": ${WIREGUARD_PORT},
  "bmcAddress": "${BMC_ADDRESS}",
  "bmcMode": "$(resolved_bmc_mode)",
  "bmcStatus": "${bmc_status}",
  "missingCommands": "$(trim "$missing")",
  "missingArtifacts": "$(trim "$missing_artifacts")"
}
EOF
  [ "$status" = "BLOCKED" ] && return 2
  return 0
}

write_file_from_renderer() {
  local destination="$1" mode="$2" renderer="$3" temp
  temp="$(mktemp)"
  "$renderer" > "$temp"
  install -d -m 0755 "$(dirname "$destination")"
  install -m "$mode" "$temp" "$destination"
  rm -f "$temp"
}

managed_paths() {
  cat <<'EOF'
/etc/netplan/60-cz-safety.yaml
/etc/nftables.conf
/etc/ssh/sshd_config.d/60-cz-safety.conf
/etc/sysctl.d/60-cz-safety.conf
/etc/audit/rules.d/60-cz-safety.rules
/etc/nginx/sites-available/cz-safety
/etc/nginx/sites-enabled/cz-safety
/etc/cz-safety/site.conf
/etc/cz-safety/peers.tsv
/usr/local/sbin/deploy-ubuntu-direct.sh
EOF
  printf '/etc/wireguard/%s.conf\n' "$WIREGUARD_INTERFACE"
}

create_backup() {
  local id backup_dir relative path
  id="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$(target_path "/var/lib/cz-safety/backups/$id")"
  install -d -m 0700 "$backup_dir/files"
  : > "$backup_dir/absent.txt"
  managed_paths | while IFS= read -r path; do
    relative="${path#/}"
    if [ -e "$(target_path "$path")" ] || [ -L "$(target_path "$path")" ]; then
      install -d -m 0700 "$backup_dir/files/$(dirname "$relative")"
      cp -a "$(target_path "$path")" "$backup_dir/files/$relative"
    else
      printf '%s\n' "$path" >> "$backup_dir/absent.txt"
    fi
  done
  printf '%s\n' "$id" > "$(target_path /var/lib/cz-safety/pending-backup)"
  printf '%s\n' "$id"
}

restore_backup() {
  local id="$1" backup_dir path source
  backup_dir="$(target_path "/var/lib/cz-safety/backups/$id")"
  [ -d "$backup_dir" ] || die "Backup not found: $id"
  if [ -f "$backup_dir/absent.txt" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      rm -rf "$(target_path "$path")"
    done < "$backup_dir/absent.txt"
  fi
  if [ -d "$backup_dir/files" ]; then
    find "$backup_dir/files" -mindepth 1 \( -type f -o -type l \) | while IFS= read -r source; do
      path="/${source#"$backup_dir/files/"}"
      install -d -m 0755 "$(dirname "$(target_path "$path")")"
      cp -a "$source" "$(target_path "$path")"
    done
  fi
  if is_target_ubuntu; then
    command -v netplan >/dev/null 2>&1 && netplan apply || true
    command -v nft >/dev/null 2>&1 && nft -f /etc/nftables.conf || true
    systemctl daemon-reload || true
    systemctl restart wg-quick@"$WIREGUARD_INTERFACE" ssh nginx 2>/dev/null || true
  fi
}

schedule_rollback() {
  local id="$1" installed_script runtime_config unit
  is_live_root || return 0
  installed_script="/usr/local/sbin/deploy-ubuntu-direct.sh"
  runtime_config="/etc/cz-safety/site.conf"
  unit="cz-safety-rollback-${id}"
  systemd-run --unit "$unit" --on-active="${ROLLBACK_MINUTES}m" "$installed_script" rollback --config "$runtime_config" --backup-id "$id" >/dev/null
  printf '%s\n' "$unit" > /var/lib/cz-safety/pending-rollback-unit
}

cancel_rollback() {
  local unit_file unit
  unit_file="$(target_path /var/lib/cz-safety/pending-rollback-unit)"
  if [ -f "$unit_file" ]; then
    unit="$(sed -n '1p' "$unit_file")"
    if is_live_root; then
      systemctl stop "${unit}.timer" "${unit}.service" 2>/dev/null || true
      systemctl reset-failed "${unit}.service" 2>/dev/null || true
    fi
    rm -f "$unit_file"
  fi
}

audit_public_listeners() {
  if ! is_live_root || ! command -v ss >/dev/null 2>&1; then
    return 0
  fi
  local offenders
  offenders="$(ss -H -lntup 2>/dev/null | awk '$5 ~ /(^|\])0\.0\.0\.0:|(^|\])\[::\]:|^\*:/ {print}' | grep -Ev ":${WIREGUARD_PORT}([[:space:]]|$)" || true)"
  if [ -n "$offenders" ]; then
    printf '%s\n' "$offenders" >&2
    warn "Wildcard listeners were found. nftables will keep them off the WAN; review the evidence after apply."
  fi
}

validate_admin_public_key() {
  [ -f "$SSH_ADMIN_PUBLIC_KEY_FILE" ] || die "Admin public key file not found: $SSH_ADMIN_PUBLIC_KEY_FILE"
  grep -Eq '^(ssh-ed25519|sk-ssh-ed25519@openssh.com|ecdsa-sha2-nistp(256|384|521)|sk-ecdsa-sha2-nistp256@openssh.com|ssh-rsa)[[:space:]]+[A-Za-z0-9+/=]+' "$SSH_ADMIN_PUBLIC_KEY_FILE" || die "Admin public key file does not contain an OpenSSH public key"
}

prepare_admin_account() {
  local source_key home primary_group
  source_key="$SSH_ADMIN_PUBLIC_KEY_FILE"
  validate_admin_public_key
  getent group "$SSH_ADMIN_GROUP" >/dev/null || groupadd --system "$SSH_ADMIN_GROUP"
  if ! id "$SSH_ADMIN_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$SSH_ADMIN_USER"
  fi
  local required_group
  for required_group in "$SSH_ADMIN_GROUP" sudo; do
    getent group "$required_group" >/dev/null || die "Required group not found: $required_group"
    if ! id -nG "$SSH_ADMIN_USER" | tr ' ' '\n' | grep -Fxq "$required_group"; then
      usermod -aG "$required_group" "$SSH_ADMIN_USER"
    fi
  done
  home="$(getent passwd "$SSH_ADMIN_USER" | awk -F: '{print $6}')"
  [ -n "$home" ] || die "Unable to resolve home directory for $SSH_ADMIN_USER"
  primary_group="$(id -gn "$SSH_ADMIN_USER")"
  install -d -m 0700 -o "$SSH_ADMIN_USER" -g "$primary_group" "$home/.ssh"
  install -m 0600 -o "$SSH_ADMIN_USER" -g "$primary_group" "$source_key" "$home/.ssh/authorized_keys"
  passwd -l "$SSH_ADMIN_USER" >/dev/null 2>&1 || true
}

install_packages() {
  case "$PACKAGE_MODE" in
    skip) return 0 ;;
    online)
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y nftables wireguard-tools openssh-server nginx auditd aide unattended-upgrades
      ;;
    offline)
      local deb_dir
      deb_dir="$(dirname "$CONFIG_PATH")/offline-debs"
      [ -d "$deb_dir" ] || die "Offline package directory not found: $deb_dir"
      dpkg -i "$deb_dir"/*.deb || die "Offline package installation failed; bundle dependencies are incomplete"
      ;;
  esac
}

ensure_server_key() {
  local secrets key
  secrets="$(target_path /etc/cz-safety/secrets)"
  key="$secrets/wg-server.key"
  install -d -m 0700 "$secrets"
  if [ ! -s "$key" ]; then
    umask 077
    wg genkey > "$key"
  fi
  chmod 0600 "$key"
}

apply_config() {
  [ "$CONFIRM_CONSOLE" = "yes" ] || die "apply requires --confirm-console"
  is_live_root || die "apply is only allowed with CZ_SAFETY_ROOT=/ on the target Ubuntu host"
  [ "$(id -u)" -eq 0 ] || die "apply must run as root"
  validate_config
  is_example_wan && die "Refusing to apply a documentation/test WAN address"
  [ "$(platform_status)" = "PASS" ] || die "Ubuntu Server 24.04 LTS is required"
  require_command ip
  ip link show "$WAN_INTERFACE" >/dev/null 2>&1 || die "WAN interface not found: $WAN_INTERFACE"
  if [ "$(resolved_bmc_mode)" != disabled ]; then
    ip link show "$BMC_INTERFACE" >/dev/null 2>&1 || die "BMC interface not found: $BMC_INTERFACE"
  fi
  validate_admin_public_key
  audit_public_listeners
  install_packages
  for command_name in nft wg wg-quick sshd netplan systemctl augenrules; do require_command "$command_name"; done
  install -d -m 0700 /var/lib/cz-safety/backups
  local backup
  backup="$(create_backup)"
  install -d -m 0700 /etc/cz-safety /etc/cz-safety/secrets /etc/cz-safety/peers.d /var/lib/cz-safety/exports
  install -m 0600 "$CONFIG_PATH" /etc/cz-safety/site.conf
  install -m 0755 "$0" /usr/local/sbin/deploy-ubuntu-direct.sh
  [ -f /etc/cz-safety/peers.tsv ] || install -m 0600 /dev/null /etc/cz-safety/peers.tsv
  schedule_rollback "$backup"
  prepare_admin_account
  ensure_server_key
  write_file_from_renderer /etc/netplan/60-cz-safety.yaml 0600 render_netplan
  write_file_from_renderer /etc/nftables.conf 0600 render_nftables
  write_file_from_renderer /etc/ssh/sshd_config.d/60-cz-safety.conf 0644 render_sshd_dropin
  write_file_from_renderer /etc/sysctl.d/60-cz-safety.conf 0644 render_sysctl
  write_file_from_renderer /etc/audit/rules.d/60-cz-safety.rules 0640 render_audit_rules
  write_file_from_renderer "/etc/wireguard/${WIREGUARD_INTERFACE}.conf" 0600 render_wireguard
  if [ "$ENABLE_HTTPS" = "yes" ]; then
    [ -f "$TLS_CERT_PATH" ] && [ -f "$TLS_KEY_PATH" ] || die "HTTPS enabled but TLS certificate/key are missing"
    write_file_from_renderer /etc/nginx/sites-available/cz-safety 0644 render_nginx
    ln -sfn /etc/nginx/sites-available/cz-safety /etc/nginx/sites-enabled/cz-safety
    nginx -t
  fi
  netplan generate
  nft -c -f /etc/nftables.conf
  sshd -t
  sysctl --system >/dev/null
  netplan apply
  systemctl enable --now nftables "wg-quick@${WIREGUARD_INTERFACE}" ssh auditd unattended-upgrades
  augenrules --load
  systemctl reload ssh
  [ "$ENABLE_HTTPS" = "yes" ] && systemctl enable --now nginx
  info "Applied configuration. Automatic rollback is armed for ${ROLLBACK_MINUTES} minutes."
  info "Run verify, test an external admin peer, then run confirm."
}

next_peer_address() {
  local role="$1" file
  file="$(peers_file)"
  python3 - "$role" "$ADMIN_VPN_CIDR" "$EMPLOYEE_VPN_CIDR" "$file" <<'PY'
import ipaddress, pathlib, sys
role, admin_cidr, employee_cidr, filename = sys.argv[1:]
network = ipaddress.ip_network(admin_cidr if role == "admin" else employee_cidr, strict=False)
used = set()
path = pathlib.Path(filename)
if path.exists():
    for line in path.read_text().splitlines():
        fields = line.split("\t")
        if len(fields) >= 3:
            used.add(ipaddress.ip_address(fields[2]))
hosts = list(network.hosts())
if role == "admin" and hosts:
    hosts = hosts[1:]  # reserve the first admin address for the gateway
for candidate in hosts:
    if candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit("No unused peer addresses remain")
PY
}

validate_peer_name() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || die "Invalid peer name"
}

reload_runtime_rules() {
  write_file_from_renderer "$(target_path /etc/nftables.conf)" 0600 render_nftables
  write_file_from_renderer "$(target_path "/etc/wireguard/${WIREGUARD_INTERFACE}.conf")" 0600 render_wireguard
  if is_live_root; then
    nft -c -f /etc/nftables.conf
    nft -f /etc/nftables.conf
    wg syncconf "$WIREGUARD_INTERFACE" <(wg-quick strip "$WIREGUARD_INTERFACE")
  fi
}

peer_add() {
  [ "$(id -u)" -eq 0 ] || die "peer-add must run as root"
  validate_config
  validate_peer_name "$PEER_NAME"
  case "$PEER_ROLE" in admin|employee) ;; *) die "--role must be admin or employee" ;; esac
  require_command wg
  local file address private public psk server_public export_file server_file peers
  file="$(peers_file)"
  awk -F '\t' -v name="$PEER_NAME" '$1 == name {found=1} END {exit !found}' "$file" 2>/dev/null && die "Peer already exists: $PEER_NAME"
  address="$(next_peer_address "$PEER_ROLE")"
  private="$(wg genkey)"
  public="$(printf '%s' "$private" | wg pubkey)"
  psk="$(wg genpsk)"
  server_public="$(sed -n '1p' "$(target_path /etc/cz-safety/secrets/wg-server.key)" | wg pubkey)"
  peers="$(target_path /etc/cz-safety/peers.d)"
  export_file="$(target_path "/var/lib/cz-safety/exports/${PEER_NAME}.conf")"
  server_file="$peers/${PEER_NAME}.server.conf"
  install -d -m 0700 "$peers" "$(dirname "$export_file")"
  umask 077
  cat > "$server_file" <<EOF
# name=${PEER_NAME} role=${PEER_ROLE}
[Peer]
PublicKey = ${public}
PresharedKey = ${psk}
AllowedIPs = ${address}/32
EOF
  cat > "$export_file" <<EOF
[Interface]
Address = ${address}/32
PrivateKey = ${private}

[Peer]
PublicKey = ${server_public}
PresharedKey = ${psk}
Endpoint = ${WAN_CIDR%/*}:${WIREGUARD_PORT}
AllowedIPs = $(if [ "$PEER_ROLE" = admin ] && [ "$(resolved_bmc_mode)" != disabled ]; then printf '%s, %s/32' "${WIREGUARD_ADDRESS%/*}/32" "$BMC_ADDRESS"; else printf '%s/32' "${WIREGUARD_ADDRESS%/*}"; fi)
PersistentKeepalive = 25
EOF
  printf '%s\t%s\t%s\t%s\n' "$PEER_NAME" "$PEER_ROLE" "$address" "$public" >> "$file"
  chmod 0600 "$server_file" "$export_file" "$file"
  reload_runtime_rules
  info "Peer created: $PEER_NAME ($PEER_ROLE, $address)"
  info "Secret client config: $export_file"
}

peer_revoke() {
  [ "$(id -u)" -eq 0 ] || die "peer-revoke must run as root"
  validate_config
  validate_peer_name "$PEER_NAME"
  local file temp
  file="$(peers_file)"
  awk -F '\t' -v name="$PEER_NAME" '$1 == name {found=1} END {exit !found}' "$file" 2>/dev/null || die "Peer not found: $PEER_NAME"
  temp="$(mktemp)"
  awk -F '\t' -v name="$PEER_NAME" '$1 != name' "$file" > "$temp"
  install -m 0600 "$temp" "$file"
  rm -f "$temp" "$(target_path "/etc/cz-safety/peers.d/${PEER_NAME}.server.conf")" "$(target_path "/var/lib/cz-safety/exports/${PEER_NAME}.conf")"
  reload_runtime_rules
  info "Peer revoked: $PEER_NAME"
}

write_report() {
  local status="$1" output="$2" platform bmc
  platform="$(platform_status)"
  bmc="$(resolved_bmc_mode)"
  install -d -m 0700 "$(dirname "$output")"
  cat > "$output" <<EOF
{
  "schemaVersion": 1,
  "script": "deploy-ubuntu-direct.sh",
  "topology": "ubuntu-direct",
  "status": "${status}",
  "developmentChecks": "RUN_SEPARATELY",
  "ubuntuRuntime": "${platform}",
  "bmcRuntime": "$(if [ "$bmc" = disabled ]; then printf 'DISABLED_SAFE'; else printf 'PENDING_SITE'; fi)",
  "publicNetworkRuntime": "PENDING_SITE",
  "generatedAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  chmod 0600 "$output"
}

verify_live() {
  validate_config
  local report_dir report status="PENDING_EXTERNAL_VERIFY" failed=0
  report_dir="${OUTPUT_DIR:-$(target_path "/var/lib/cz-safety/evidence/$(date -u +%Y%m%dT%H%M%SZ)")}"
  report="$report_dir/acceptance.json"
  if ! is_live_root || [ "$(platform_status)" != PASS ]; then
    status="PENDING_UBUNTU_SITE"
  else
    nft list ruleset | grep -q 'table inet cz_safety' || failed=1
    systemctl is-active --quiet "wg-quick@${WIREGUARD_INTERFACE}" || failed=1
    sshd -T | grep -q '^passwordauthentication no$' || failed=1
    [ "$failed" -eq 0 ] || status="FAIL"
  fi
  write_report "$status" "$report"
  info "Acceptance report: $report"
  [ "$status" = FAIL ] && return 1
}

confirm_config() {
  is_live_root || die "confirm is only allowed on the target Ubuntu host"
  [ "$(id -u)" -eq 0 ] || die "confirm must run as root"
  [ "$CONFIRM_EXTERNAL" = "yes" ] || die "confirm requires --confirm-external after a real off-host WireGuard and SSH test"
  [ -f "$(target_path /var/lib/cz-safety/pending-backup)" ] || die "No pending deployment to confirm"
  nft list ruleset | grep -q 'table inet cz_safety' || die "Cannot confirm: nftables policy is not active"
  systemctl is-active --quiet "wg-quick@${WIREGUARD_INTERFACE}" || die "Cannot confirm: WireGuard is not active"
  sshd -T | grep -q '^passwordauthentication no$' || die "Cannot confirm: SSH password authentication is still enabled"
  cancel_rollback
  rm -f "$(target_path /var/lib/cz-safety/pending-backup)"
  info "Configuration confirmed after local checks. Keep the onsite external-role evidence with the acceptance report."
}

collect_evidence() {
  validate_config
  local out
  out="${OUTPUT_DIR:-$SCRIPT_DIR/evidence/ubuntu-$(date -u +%Y%m%dT%H%M%SZ)}"
  install -d -m 0700 "$out"
  preflight > "$out/preflight.json" || true
  print_plan | sed -E 's/^(PrivateKey|PresharedKey) = .*/\1 = <redacted>/' > "$out/plan.txt"
  if is_target_ubuntu; then
    ip -brief address > "$out/ip-address.txt" 2>&1 || true
    ip route > "$out/ip-route.txt" 2>&1 || true
    ss -lntup > "$out/listeners.txt" 2>&1 || true
    nft list ruleset > "$out/nftables.txt" 2>&1 || true
    wg show > "$out/wireguard.txt" 2>&1 || true
    sshd -T | grep -E '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|allowgroups)' > "$out/sshd-effective.txt" 2>&1 || true
  fi
  write_report "$(if is_target_ubuntu; then printf PENDING_SITE_VERIFY; else printf READY_FOR_SITE; fi)" "$out/acceptance.json"
  info "Evidence directory: $out"
}

prepare_bundle() {
  validate_config
  [ "$(uname -s)" = Linux ] || die "prepare-bundle must run on a matching Ubuntu 24.04 host"
  [ "$(platform_status)" = PASS ] || die "prepare-bundle requires Ubuntu 24.04"
  # Root is intentional: refresh the system apt indexes and resolve against the
  # matching Ubuntu dpkg state instead of producing a best-effort partial set.
  [ "$(id -u)" -eq 0 ] || die "prepare-bundle must run as root"
  local out
  out="${OUTPUT_DIR:-$SCRIPT_DIR/offline-debs}"
  install -d -m 0755 "$out"
  apt-get update
  apt-get install --download-only -y -o "Dir::Cache::archives=$out" nftables wireguard-tools openssh-server nginx auditd aide unattended-upgrades
  (cd "$out" && sha256sum ./*.deb > SHA256SUMS)
  info "Offline Ubuntu packages: $out"
}

self_test() {
  require_command python3
  local temp config plan invalid
  temp="$(mktemp -d)"
  config="$temp/site.conf"
  cat > "$config" <<'EOF'
WAN_INTERFACE=eth0
WAN_CIDR=203.0.113.106/30
WAN_GATEWAY=203.0.113.105
WIREGUARD_INTERFACE=wg0
WIREGUARD_ADDRESS=10.203.0.1/24
ADMIN_VPN_CIDR=10.203.0.0/26
EMPLOYEE_VPN_CIDR=10.203.0.128/25
BMC_MODE=routed
BMC_INTERFACE=eth1
BMC_GATEWAY_CIDR=192.168.100.1/24
BMC_ADDRESS=192.168.100.10
BMC_WEB_PORT=443
ENABLE_HTTPS=no
EGRESS_MODE=strict
PACKAGE_MODE=skip
EOF
  CONFIG_PATH="$config"
  TARGET_ROOT="$temp/root"
  load_config
  validate_config
  plan="$temp/plan"
  print_plan > "$plan"
  grep -q 'policy drop' "$plan" || die "self-test: default drop missing"
  grep -q '192.168.100.10' "$plan" || die "self-test: BMC address missing"
  grep -q 'PasswordAuthentication no' "$plan" || die "self-test: SSH password hardening missing"
  grep -q 'udp dport 51820 accept' "$plan" || die "self-test: WireGuard WAN rule missing"
  invalid="$temp/invalid.conf"
  sed 's/WAN_CIDR=203.0.113.106\/30/WAN_CIDR=203.0.113.104\/30/' "$config" > "$invalid"
  CONFIG_PATH="$invalid"
  load_config
  if validate_config >/dev/null 2>&1; then
    die "self-test: network address was accepted"
  fi
  CONFIG_PATH="$config"
  load_config
  rm -rf "$temp"
  info "self-test PASS"
}

parse_args() {
  [ "$#" -gt 0 ] || { usage; exit 2; }
  ACTION="$1"
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --config) CONFIG_PATH="${2:-}"; shift ;;
      --name) PEER_NAME="${2:-}"; shift ;;
      --role) PEER_ROLE="${2:-}"; shift ;;
      --confirm-console) CONFIRM_CONSOLE="yes" ;;
      --confirm-external) CONFIRM_EXTERNAL="yes" ;;
      --backup-id) BACKUP_ID="${2:-}"; shift ;;
      --output-dir) OUTPUT_DIR="${2:-}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
    shift
  done
  case "$ACTION" in
    self-test) ;;
    *) [ -n "$CONFIG_PATH" ] || die "--config is required" ;;
  esac
}

main() {
  parse_args "$@"
  case "$ACTION" in
    self-test) set_defaults; self_test ;;
    preflight) load_config; preflight ;;
    plan) load_config; print_plan ;;
    prepare-bundle) load_config; prepare_bundle ;;
    apply) load_config; apply_config ;;
    verify) load_config; verify_live ;;
    confirm) load_config; validate_config; confirm_config ;;
    rollback)
      load_config
      validate_config
      if [ -z "$BACKUP_ID" ]; then
        [ -f "$(target_path /var/lib/cz-safety/pending-backup)" ] || die "No pending backup"
        BACKUP_ID="$(sed -n '1p' "$(target_path /var/lib/cz-safety/pending-backup)")"
      fi
      restore_backup "$BACKUP_ID"
      cancel_rollback
      info "Rollback restored: $BACKUP_ID"
      ;;
    peer-add) load_config; [ -n "$PEER_NAME" ] || die "--name is required"; [ -n "$PEER_ROLE" ] || die "--role is required"; peer_add ;;
    peer-revoke) load_config; [ -n "$PEER_NAME" ] || die "--name is required"; peer_revoke ;;
    evidence) load_config; collect_evidence ;;
    -h|--help|help) usage ;;
    *) die "Unknown action: $ACTION" ;;
  esac
}

main "$@"
