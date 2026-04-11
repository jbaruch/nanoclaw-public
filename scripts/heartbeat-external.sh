#!/usr/bin/env bash
set -euo pipefail

# External heartbeat — last-resort watchdog.
# Only checks if NanoClaw is running. Everything else is handled by the agent.
# Sends alert to 1:1 Telegram chat if NanoClaw is down.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/heartbeat-external.conf"
LOG_TAG="[$(date '+%Y-%m-%d %H:%M:%S')] heartbeat-external"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "$LOG_TAG ERROR: config file not found: $CONFIG_FILE" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

send_telegram() {
  local text="$1"
  curl -sf --max-time 15 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=${text}" \
    -o /dev/null
}

# ── Is NanoClaw running? ─────────────────────────────────────────────────────
running=false
if [[ "$(uname)" == "Darwin" ]]; then
  launchctl list com.nanoclaw &>/dev/null && running=true
else
  docker ps --filter "name=^nanoclaw$" --filter "status=running" -q 2>/dev/null | grep -q . && running=true
fi

if $running; then
  echo "$LOG_TAG OK"
  exit 0
fi

# ── NanoClaw is down — alert ─────────────────────────────────────────────────
hostname_short=$(hostname -s 2>/dev/null || hostname)
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
msg="🔴 <b>NanoClaw is DOWN</b>"$'\n'$'\n'
msg+="Container not running on ${hostname_short}."$'\n'
msg+="Run: <code>cd ~/nanoclaw && docker compose up -d</code>"$'\n'$'\n'
msg+="<i>${timestamp}</i>"

echo "$LOG_TAG ALERT: NanoClaw is not running"

# Check if Telegram is reachable before trying to send
tg_status=$(curl -sf --max-time 10 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" \
  -o /dev/null -w '%{http_code}' 2>/dev/null || echo "000")

if [[ "$tg_status" == "200" ]]; then
  send_telegram "$msg" || echo "$LOG_TAG ERROR: failed to send Telegram alert" >&2
else
  echo "$LOG_TAG ERROR: Telegram unreachable (HTTP $tg_status), cannot send alert" >&2
fi

exit 1
