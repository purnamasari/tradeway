#!/usr/bin/env bash
#
# External health probe for tradeaway, intended for cron. PM2 keeps the process
# alive; this catches the case PM2 can't see — process up but scans wedged/stale
# (the /health endpoint returns 503) or the port not responding at all.
#
# On failure it pings PM2 to restart and (if Telegram is configured in .env)
# sends an alert. Install as a cron entry, e.g. every 5 minutes:
#
#   */5 * * * * /path/to/tradeaway/scripts/healthcheck.sh >> /path/to/tradeaway/logs/healthcheck.log 2>&1
set -uo pipefail

cd "$(dirname "$0")/.."

# Load TELEGRAM_* (and HEALTH_PORT) from .env without exporting everything noisily.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

HEALTH_PORT="${HEALTH_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
TS="$(date -u +%FT%TZ)"

alert() {
  local msg="$1"
  echo "[$TS] $msg"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS --max-time 10 \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=⚠️ tradeaway healthcheck: ${msg}" >/dev/null || true
  fi
}

# curl exits 22 on HTTP >=400 (incl. our 503). Capture the body for diagnostics.
if body="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null)"; then
  echo "[$TS] ok"
  exit 0
fi

# Unhealthy or unreachable — try to read why (without -f so we still get the 503 body).
detail="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
alert "endpoint failing (${detail:-no response}) — restarting via pm2"
pm2 restart tradeaway >/dev/null 2>&1 || alert "pm2 restart failed — manual intervention needed"
exit 1
