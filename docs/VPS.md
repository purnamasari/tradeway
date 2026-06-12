# VPS Deployment Guide

The bot runs as a PM2-managed Node worker on a VPS with direct Bybit access.
This guide covers a fresh deployment plus the strategy-engine (H18) rollout.
The bot is **read-only and advisory**: it never places, modifies, or closes
exchange orders.

## 1. Provision

- Node.js ≥ 22 (uses `process.loadEnvFile`, global `WebSocket`)
- pnpm ≥ 10 (`corepack enable && corepack prepare pnpm@latest --activate`)
- PM2 (`npm i -g pm2`)
- PostgreSQL reachable from the box (Neon or local). Mind transfer quotas:
  the engine's hybrid provider reads candle history from the DB each boot.

```sh
git clone <repo> tradeaway && cd tradeaway
pnpm install
pnpm chrome:install        # chart rendering (puppeteer-core)
```

## 2. Configure

`.env` (minimum):

```
DATABASE_URL=postgresql://…
TELEGRAM_BOT_TOKEN=…       # omit → console alerts
TELEGRAM_CHAT_ID=…
GEMINI_API_KEY=…           # optional (trend tiers); rule fallback otherwise
REDIS_URL=…                # optional (BullMQ scheduler; in-process fallback)
HEALTH_PORT=8787
```

`config/watchlist.yaml` — symbols + scan intervals.
`config/rules.yaml` — thresholds; the `engine:` block stays
`enabled: false` until §5.

## 3. Database schema

```sh
pnpm db:push                                   # full drizzle sync (preferred)
# or, if push is unavailable (e.g. provider quota), the additive pieces only:
pnpm exec tsx scripts/apply-engine-columns.ts  # engine columns on signal_outcomes
```

The `candles` table (historical store) is part of the schema push. All
changes are additive — no destructive migrations.

## 4. Historical candle data (required before enabling the engine)

```sh
pnpm fetch:history --all              # 15m/1h/4h/1d, 480d, all watchlist symbols
pnpm verify:history                   # coverage, gaps, staleness report
pnpm fetch:history --all --repair     # if verify reports gaps
```

- Restart-safe: re-running resumes from what the DB already has.
- Idempotent: duplicates are impossible (composite PK + DO NOTHING).
- Keep it fresh with a daily cron (the engine's hybrid provider also
  write-throughs the live tail, so this is belt-and-braces):

```cron
17 1 * * * cd /opt/tradeaway && pnpm fetch:history --all >> logs/history.log 2>&1
19 1 * * 0 cd /opt/tradeaway && pnpm verify:history >> logs/history.log 2>&1
```

H18 needs ≥ 31 days of 15m candles per symbol (30d momentum lookback + 1);
the 480d default gives ample headroom.

## 5. Enabling the strategy engine (H18, advisory paper mode)

Pre-flight, in order:

1. `pnpm db:push` (or the apply-columns script) succeeded.
2. `pnpm verify:history` exits 0 for every symbol.
3. `pnpm test:engine` passes.
4. `pnpm test:h18:replay` passes. The replay compares the production strategy
   against the research reference over 2023–2026 candle caches, which are
   gitignored build artifacts — on a fresh checkout build them first:

   ```sh
   sudo apt install -y unzip       # once
   chmod +x research/*.sh
   ./research/fetch-replay-data.sh # BTCUSDT+ETHUSDT, ~80MB from data.binance.vision
   ```

   (Optional on the VPS — the replay is deterministic, so a pass on any
   machine is equally valid; run it wherever bandwidth is cheapest.)

Then in `config/rules.yaml`:

```yaml
engine:
  enabled: true
  strategies: [H18]
  risk_model: fixed_fraction   # paper sizing; advisory = no sizes shown
  equity: 10000
  risk_fraction: 0.01
```

Restart (`pm2 reload tradeaway`). The engine runs a 60s bar-close cycle:
decisions only on closed 15m bars, positions tracked as `source='engine'`
rows, Telegram messages headed `Strategy: H18`. Legacy SMC scanning,
tracking, and alerts continue unchanged alongside.

## 6. Run under PM2

```sh
pm2 start ecosystem.config.cjs
pm2 save
```

## 7. Monitor

- `GET :8787/health` — scan heartbeats, feed status, and the `engine` key
  (cycles, latency, signals, fills, exits, stop moves) when enabled.
- `pnpm engine:compare --days=30` — engine vs legacy signal volumes/outcomes
  (the paper-trading scorecard).
- `/running` in Telegram lists engine positions alongside legacy ones
  (strategy column shows `H18`).

## 8. Rollback

Set `engine.enabled: false` and reload — open engine positions stop being
driven (standing stops are not evaluated while disabled), so close the loop:
either leave the engine on with `strategies: []` (cycle keeps protecting open
positions but takes no new entries) or manually resolve open `source='engine'`
rows. Prefer `strategies: []` for a soft stop.
