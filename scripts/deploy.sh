#!/usr/bin/env bash
#
# Idempotent deploy for tradeaway. Run on the VPS — either by the CI/CD pipeline
# over SSH (.github/workflows/deploy.yml) or by hand:
#
#   cd /path/to/tradeaway && ./scripts/deploy.sh
#
# Pulls the latest main, installs deps (incl. tsx, the runtime), applies any DB
# migrations, reloads PM2 with zero downtime, and verifies /health before
# declaring success — rolling the message into a non-zero exit if the bot doesn't
# come back healthy, so the pipeline goes red.
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
echo "▶ Deploying tradeaway in $APP_DIR"

# ── 1. Pull latest code ───────────────────────────────────────────────────────
BRANCH="${DEPLOY_BRANCH:-main}"
echo "▶ git fetch + reset to origin/$BRANCH"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"
COMMIT="$(git rev-parse --short HEAD)"
echo "  now at $COMMIT"

# ── 2. Install dependencies ───────────────────────────────────────────────────
# Full install (NOT --prod): the app runs from TypeScript source via tsx, which
# is a devDependency. --frozen-lockfile guarantees we deploy the locked versions.
echo "▶ pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

# ── 3. Database migrations (no-op if DATABASE_URL is unset) ────────────────────
if grep -qE '^DATABASE_URL=.+' .env 2>/dev/null; then
  echo "▶ applying DB migrations (drizzle-kit migrate)"
  pnpm exec drizzle-kit migrate || {
    echo "✖ migration failed" >&2
    exit 1
  }
else
  echo "▶ no DATABASE_URL — skipping migrations"
fi

# ── 4. Reload under PM2 (zero-downtime) ───────────────────────────────────────
# GIT_COMMIT is surfaced by /health so we can confirm what's live. `pm2 startOrReload`
# starts the app if it isn't running yet, otherwise reloads it in place.
export GIT_COMMIT="$COMMIT"
echo "▶ pm2 startOrReload ecosystem.config.cjs"
mkdir -p logs
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# ── 5. Health gate ────────────────────────────────────────────────────────────
HEALTH_PORT="${HEALTH_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
echo "▶ verifying $HEALTH_URL"
for i in $(seq 1 10); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✔ healthy — deploy of $COMMIT complete"
    exit 0
  fi
  echo "  not ready yet ($i/10)…"
  sleep 3
done

echo "✖ health check never passed — check 'pm2 logs tradeaway'" >&2
pm2 status tradeaway || true
exit 1
