#!/usr/bin/env bash
set -uo pipefail

FRPS_SERVICE="${FRPS_SERVICE:-frps}"
FRPS_CONFIG="${FRPS_CONFIG:-/etc/frp/frps.toml}"
FRPS_LOG="${FRPS_LOG:-/var/log/frps.log}"
CONTROL_PORT="${FRPS_BIND_PORT:-7000}"
SSH_PORT="${FRPS_SSH_PORT:-2222}"
WEB_PORT="${FRPS_WEB_PORT:-2444}"
WEB_PROXY_NAME="${FRPS_WEB_PROXY_NAME:-hermes-agent-web-$WEB_PORT}"
LLM_PORT="${FRPS_LLM_PORT:-9000}"
LLM_PROXY_NAME="${FRPS_LLM_PROXY_NAME:-ai-llm-qwen36-$LLM_PORT}"
AI_CHAT_WEB_PORT="${FRPS_AI_CHAT_WEB_PORT:-9999}"
AI_CHAT_WEB_PROXY_NAME="${FRPS_AI_CHAT_WEB_PROXY_NAME:-ai-chat-web-$AI_CHAT_WEB_PORT}"
FAILURES=0

write_check() {
  local status="$1"
  local name="$2"
  local detail="${3:-}"
  if [ -n "$detail" ]; then
    printf '[%s] %s - %s\n' "$status" "$name" "$detail"
  else
    printf '[%s] %s\n' "$status" "$name"
  fi
}

pass() {
  write_check "OK" "$1" "${2:-}"
}

fail() {
  write_check "FAIL" "$1" "${2:-}"
  FAILURES=$((FAILURES + 1))
}

info() {
  write_check "INFO" "$1" "${2:-}"
}

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "command $command_name" "$(command -v "$command_name")"
  else
    fail "command $command_name" "not found"
  fi
}

check_listener() {
  local port="$1"
  local label="$2"
  local output
  output="$(ss -tlnp 2>/dev/null | grep -E "(:|\\*)$port([[:space:]]|$)" || true)"
  if [ -n "$output" ]; then
    pass "$label listener" "$output"
  else
    fail "$label listener" "no TCP listener for port $port"
  fi
}

check_config_port() {
  local port="$1"
  local label="$2"
  if [ ! -r "$FRPS_CONFIG" ]; then
    fail "frps config readable" "$FRPS_CONFIG is not readable"
    return
  fi
  if grep -Eq "start[[:space:]]*=[[:space:]]*$port|end[[:space:]]*=[[:space:]]*$port" "$FRPS_CONFIG"; then
    pass "$label allowPorts" "found $port in $FRPS_CONFIG"
  else
    fail "$label allowPorts" "missing $port in $FRPS_CONFIG"
  fi
}

check_log_proxy() {
  local proxy_name="$1"
  local label="$2"
  if [ ! -r "$FRPS_LOG" ]; then
    fail "frps log readable" "$FRPS_LOG is not readable"
    return
  fi
  local output
  output="$(grep -n "$proxy_name" "$FRPS_LOG" | tail -n 5 || true)"
  if [ -n "$output" ]; then
    pass "$label proxy log" "$output"
  else
    fail "$label proxy log" "missing $proxy_name in $FRPS_LOG"
  fi
}

info "expected web proxy" "$WEB_PROXY_NAME -> remote $WEB_PORT"
info "expected LLM proxy" "$LLM_PROXY_NAME -> remote $LLM_PORT"
info "expected AI chat web proxy" "$AI_CHAT_WEB_PROXY_NAME -> remote $AI_CHAT_WEB_PORT"
check_command systemctl
check_command ss
check_command grep

if systemctl is-active --quiet "$FRPS_SERVICE"; then
  pass "frps service" "$FRPS_SERVICE is active"
else
  fail "frps service" "systemctl is-active $FRPS_SERVICE failed"
fi

check_listener "$CONTROL_PORT" "frps control $CONTROL_PORT"
check_listener "$SSH_PORT" "ssh proxy $SSH_PORT"
check_listener "$WEB_PORT" "Hermes web proxy $WEB_PORT"
check_listener "$LLM_PORT" "LLM proxy $LLM_PORT"
check_listener "$AI_CHAT_WEB_PORT" "AI chat web proxy $AI_CHAT_WEB_PORT"

if [ -r "$FRPS_CONFIG" ]; then
  pass "frps config readable" "$FRPS_CONFIG"
  if grep -n "allowPorts" "$FRPS_CONFIG" >/dev/null 2>&1; then
    pass "allowPorts present" "$FRPS_CONFIG"
  else
    fail "allowPorts present" "missing allowPorts in $FRPS_CONFIG"
  fi
else
  fail "frps config readable" "$FRPS_CONFIG is not readable"
fi
check_config_port "$SSH_PORT" "ssh proxy $SSH_PORT"
check_config_port "$WEB_PORT" "Hermes web proxy $WEB_PORT"
check_config_port "$LLM_PORT" "LLM proxy $LLM_PORT"
check_config_port "$AI_CHAT_WEB_PORT" "AI chat web proxy $AI_CHAT_WEB_PORT"
check_log_proxy "$WEB_PROXY_NAME" "web"
check_log_proxy "$LLM_PROXY_NAME" "LLM"
check_log_proxy "$AI_CHAT_WEB_PROXY_NAME" "AI chat web"

if [ "$FAILURES" -eq 0 ]; then
  pass "frps diagnostic summary" "all checks passed"
else
  fail "frps diagnostic summary" "$FAILURES check(s) failed"
fi

exit "$FAILURES"
