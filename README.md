# tradeaway

Crypto signal bot — MVP implementing **Blueprint v3**. Scans a watchlist of
perpetuals on Bybit, classifies market regime and 4H trend, runs strategy
detectors, scores each setup on two independent axes, and emits explainable
alerts.

This is the **end-to-end thin slice**: one full pipeline proving the
architecture. It runs **keyless** out of the box — public Bybit REST needs no
API key, the AI trend classifier falls back to a rule-based classifier when no
Gemini key is set, and alerts print to the console when Telegram isn't
configured.

## Pipeline

```
Bybit market data ──▶ Regime Engine ──▶ AI Trend Classifier ──▶ S/R Engine
   (1m/15m/4h,          (rule-based:        (Gemini → fallback:    (swing pivots,
    funding, OI)         ADX/ATR/EMA)        EMA/ADX rules)         clustered, scored)
                              │                    │                     │
                              └──────────┬─────────┴──────────┬──────────┘
                                         ▼                    ▼
                              Strategy Detectors ──▶  Scoring  ──▶  Gates  ──▶  Alert
                              (liquidity_sweep,      (confidence +    (conf/quality/    (Telegram
                               trend_pullback,        setup_quality)   RR/cooldown)       or console)
                               squeeze)
```

Two components answer **different** questions and never override each other:

| Component | Question | How |
|-----------|----------|-----|
| **Regime Engine** | "What strategy fits current conditions?" | Pure math (ADX, ATR percentile, EMA spread). No AI. |
| **AI Trend Classifier** | "Which way is 4H momentum going?" | Gemini 2.5 Flash → Flash-Lite → EMA/ADX rule fallback. |
| **S/R Engine** | "Where are key horizontal support/resistance levels?" | Swing pivots, clustered, strength scored. |
| **Outcome Evaluator** | "Did active signals hit entry, TP, SL, or expire?" | 1-minute polling of ticker price against active outcomes in DB. |

A signal needs both to agree (e.g. `regime=ranging` **AND** `trend=bullish` →
`liquidity_sweep LONG` permitted).

### Strategy detectors

| Strategy | Regime Gate | Pattern |
|----------|-------------|---------|
| **liquidity_sweep** | `ranging` | Wick sweeps S/R level, then reclaims (bounce) |
| **trend_pullback** | `trending` | Price pulls back to S/R, then bounces in trend direction |
| **squeeze** | `high_volatility` | Extreme funding (percentile) + open interest shift |

When multiple detectors fire, the scanner selects the signal with the highest
**combined score** (`confidence × 0.6 + setup_quality × 0.4`).

### Two scores per signal

- **Confidence** (0–100) — *market conditions*: funding extremity, OI z-score,
  volume percentile, regime alignment.
- **Setup Quality** (0–100) — *technical structure*: S/R level strength, engulf
  body ratio, HTF alignment, sweep wick ratio, structure intact.

## Quick start

```bash
pnpm install

# Single pass against LIVE Bybit data (needs internet; no API key required)
pnpm scan:once

# Single pass against deterministic OFFLINE mock data (no network)
pnpm scan:once -- --mock

# Mock: pullback scenario (trending regime + trend_pullback detector)
pnpm scan:once -- --mock --mock-scenario=pullback

# Mock: squeeze scenario (high_volatility regime + squeeze detector)
pnpm scan:once -- --mock --mock-scenario=squeeze

# Continuous loop — per-asset interval from watchlist.yaml
pnpm scan

# Verbose decision logging
LOG_LEVEL=debug pnpm scan:once

# Test chart rendering (generates test-chart.png using mock sweep scenario)
pnpm test:chart
```

`--mock` generates synthetic candles crafted to land in a ranging regime with a
bullish 4H trend and a fresh support sweep+reclaim — i.e. a textbook
`liquidity_sweep LONG` — so you can see the full pipeline produce an alert
without waiting for live conditions to line up.

`--mock --mock-scenario=pullback` generates a trending regime with a bullish
4H trend and a pullback-to-support pattern — producing a `trend_pullback LONG`.

`--mock --mock-scenario=squeeze` generates a high-volatility regime with a bullish/bearish
4H trend and extreme funding/OI deviations — producing a `squeeze LONG/SHORT`.

Mock mode automatically disables external services (Gemini, Telegram, Redis,
Postgres) so tests are fully isolated and deterministic.

## Configuration

- `config/watchlist.yaml` — symbols, per-asset scan interval, asset class,
  per-symbol confidence overrides, global gates (min confidence/quality/RR,
  cooldown).
- `config/rules.yaml` — regime thresholds, trend tiers, scoring weights,
  retention policy.
- `.env` (optional, copy from `.env.example`) — enables enhancement layers:
  - `GEMINI_API_KEY` → AI trend classifier (else EMA/ADX fallback)
  - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → Telegram alerts (else console)
  - `REDIS_URL` → shared cache **and BullMQ job scheduling** (else in-process cache + `setInterval` scheduler)
  - `DATABASE_URL` → Postgres persistence for metric history and signals (else disabled)
  - `MARKET_FEED` → `ws` (default; streamed candles/ticker) or `rest` (per-scan polling)

Everything degrades gracefully — a missing key just disables that layer.

### Market feed & scheduling

In loop mode the bot defaults to a **WebSocket feed**: it REST-seeds candle/funding/OI
buffers once, then keeps them live via Bybit's public WS (`kline.1/15/240` + `tickers`),
so each scan reads current data instantly instead of firing six REST calls. The feed
auto-reconnects with backoff and re-seeds after a drop; its liveness shows up under
`feed` in `/health`. Set `MARKET_FEED=rest` to fall back to per-scan REST polling.

Recurring work (per-symbol scans, funding/OI poll, outcome eval, daily retention) runs
through a **scheduler** that uses **BullMQ** when `REDIS_URL` is set — durable repeatable
jobs that survive restarts, with concurrency and retries — or a dependency-free
`setInterval` fallback otherwise. `/health` reports which backend is active via the boot
log (`scheduler=bullmq|interval`).

### Telegram setup

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram,
   send `/newbot`, and follow the prompts. Copy the bot token it gives you.

2. **Get your chat ID**:
   - **Personal chat**: send any message to your bot, then open
     `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a browser.
     Look for `"chat":{"id": 123456789}` — that number is your chat ID.
   - **Group chat**: add the bot to the group, send a message in the group, then
     check the same `/getUpdates` URL. Group IDs are negative numbers
     (e.g. `-1001234567890`).
   - **Alternative**: message [@userinfobot](https://t.me/userinfobot) on
     Telegram — it replies with your user ID.

3. **Set the values** in `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=<your bot token from BotFather>
   TELEGRAM_CHAT_ID=<your chat ID>
   ```

4. **Verify** the connection sends a test message:
   ```bash
   pnpm test:telegram
   ```

### Database setup

1. **Set the connection string** in `.env`:
   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/tradeaway
   ```

2. **Push the schema** to create tables:
   ```bash
   pnpm db:push
   ```

   Tables created: `metric_history`, `signals`, `regime_log`, `signal_outcomes`.

## Deployment (VPS + PM2 + CI/CD)

The bot runs on a VPS under [PM2](https://pm2.keymetrics.io/) straight from
TypeScript source via `tsx` (no build step). Pushing to `main` triggers a GitHub
Actions pipeline that SSHes in, pulls, installs, syncs the schema, and reloads
with a health gate.

### One-time VPS setup

```bash
# Node 22 + pnpm + pm2 installed, then:
git clone https://github.com/purnamasari/tradeway.git tradeaway
cd tradeaway
cp .env.example .env        # fill in secrets
pnpm install --frozen-lockfile
pnpm db:push                # if DATABASE_URL is set — reconcile schema

pm2 start ecosystem.config.cjs
pm2 save                    # persist the process list
pm2 startup                 # print the command to enable PM2 on boot, then run it
```

### Continuous deployment

`.github/workflows/deploy.yml` runs on every push to `main`: it typechecks, then
SSHes into the VPS and runs `scripts/deploy.sh` (`git reset --hard origin/main` →
`pnpm install` → `drizzle-kit push` → `pm2 reload` → verify `/health`). A red
health check fails the deploy. Schema sync uses `push` (not migration files);
additive changes apply automatically, destructive ones abort rather than
auto-truncate (run those by hand).

Add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | Server IP or hostname |
| `VPS_USER` | SSH user that owns the app dir |
| `VPS_SSH_KEY` | Private key (the matching public key is in the server's `~/.ssh/authorized_keys`) |
| `VPS_APP_DIR` | Absolute path to the checkout, e.g. `/home/deploy/tradeaway` |
| `VPS_PORT` | SSH port (optional, defaults to `22`) |

You can also trigger a deploy manually from the **Actions** tab (`workflow_dispatch`).
To deploy by hand on the box: `./scripts/deploy.sh`.

### Health check

In loop mode the bot serves `GET /health` (default `127.0.0.1:3000`, configurable
via `HEALTH_PORT`/`HEALTH_HOST`). It reports `200` when healthy and `503` once any
symbol's scans go stale — so it catches "process up but wedged", which PM2 alone
cannot. Body includes per-symbol last-success/error, dependency status, uptime,
memory, version, and the deployed git commit:

```bash
curl -s localhost:3000/health | jq
```

Bound to loopback by default — expose it through a reverse proxy or SSH tunnel for
an external uptime monitor (UptimeRobot, BetterStack, etc.).

### Monitoring

- **PM2** — process supervision: auto-restart with crash-loop backoff,
  `max_memory_restart`, log capture. `pm2 status`, `pm2 logs tradeaway`,
  `pm2 monit`. Install `pm2-logrotate` to cap log growth.
- **Ops alerts** — startup, shutdown, and crash (`uncaughtException` /
  `unhandledRejection`) notifications go to Telegram when configured, else the
  console. Toggle with `OPS_ALERTS`.
- **Cron probe** — `scripts/healthcheck.sh` polls `/health` and, on failure,
  restarts via PM2 and alerts Telegram. Add to crontab:
  ```cron
  */5 * * * * /path/to/tradeaway/scripts/healthcheck.sh >> /path/to/tradeaway/logs/healthcheck.log 2>&1
  ```

## Layout

```
src/
  index.ts                  entry point, scheduling, --once/--mock flags
  scanner.ts                per-symbol pipeline orchestration + gates + multi-strategy
  config.ts                 typed YAML/env loaders
  cache.ts                  Redis-or-memory cache
  logger.ts                 leveled logger
  indicators.ts             EMA, ATR, ADX, percentile, z-score (pure math)
  scoring.ts                confidence + setup_quality
  notify.ts                 Telegram/console + explainability formatter
  types.ts                  shared domain types
  chart/
    renderer.ts             Puppeteer-core + system Chrome + Lightweight Charts PNG generator
    template.html           self-contained HTML/JS charting template
  data/
    bybit.ts                public v5 REST: klines, ticker, funding, OI
    market.ts               assembles per-symbol MarketContext
    mock.ts                 deterministic offline data (sweep + pullback scenarios)
  db/
    schema.ts               Drizzle schema: metric_history, signals, regime_log, signal_outcomes
    index.ts                Postgres client (graceful degradation)
    accumulate.ts           recordMetrics, recordSignal, recordRegime, outcomes & retention
  outcome/
    outcome-tracker.ts      evaluates open outcomes against live tickers every minute
  regime/engine.ts          rule-based regime classifier
  ai/trend-classifier.ts    3-tier trend classifier (Gemini → fallback)
  strategy/
    sr-engine.ts            swing pivots → clustering → strength scoring
    liquidity-sweep.ts      sweep+reclaim detector
    trend-pullback.ts       pullback-to-S/R + bounce detector
    squeeze.ts              extreme funding + OI changes in high-volatility regime detector
  test-chart.ts             quick test script to generate a mock chart to disk
  test-telegram.ts          quick Telegram connectivity test script
config/
  watchlist.yaml            symbols, scan intervals, asset classes
  rules.yaml                thresholds, weights, retention policy
drizzle.config.ts           Drizzle Kit config for schema management
```

## What's NOT in this MVP (next sprints)

Deferred to later sprints:
- **R2 Storage CDN**: Charts are sent directly as raw buffer attachments via Telegram bot API rather than stored on a CDN.
- **Squeeze two-phase WS trigger**: The squeeze detector runs per scan rather than arming a pre-condition and confirming on a WebSocket tick.
- **Prev Day/Week H/L S/R source** and **expected-path chart overlay** (calculated per strategy).

Recently landed (post-MVP):
- **Bybit WebSocket feed** — streamed candles/ticker with REST seeding + reconnect (`MARKET_FEED=ws`).
- **BullMQ scheduler** — durable repeatable jobs when `REDIS_URL` is set, `setInterval` fallback otherwise.
- **Adaptive-threshold history accumulation** — historical backfill into `market_history`.
- **CI/CD, health checks, and monitoring** — see [Deployment](#deployment-vps--pm2--cicd).
