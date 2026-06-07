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

# ── 0. Environment for non-interactive shells ─────────────────────────────────
# Over SSH / in CI this runs in a NON-interactive shell, where ~/.bashrc usually
# early-returns before its PATH setup — so pnpm installed via the standalone
# script, nvm, or corepack isn't found. Re-create that PATH here so the script
# behaves like an interactive login (and so manual runs work too).
# CI=true also lets pnpm run non-interactively (e.g. reinstall node_modules
# without prompting for a TTY).
export CI="${CI:-true}"
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
export PATH="$PNPM_HOME:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
# corepack ships pnpm with Node; enable it if pnpm still isn't resolvable.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

# Preflight: fail loudly with guidance instead of a bare "command not found".
missing=""
for bin in git pnpm pm2; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "✖ not on PATH:$missing" >&2
  echo "  PATH=$PATH" >&2
  echo "  Fix: install these for the deploy user and expose them via PNPM_HOME/" >&2
  echo "  NVM_DIR, or add their location to the workflow before ./scripts/deploy.sh." >&2
  exit 127
fi

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
echo "▶ Deploying tradeaway in $APP_DIR (pnpm $(pnpm --version), node $(node --version))"

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
