# tradeaway

Crypto signal bot — MVP implementing **Blueprint v3**. Scans a watchlist of
perpetuals on Bybit, classifies market regime and 1H trend, runs strategy
detectors, scores each setup on two independent axes, and emits explainable
alerts.

**Trading style: daytrade.** Every timeframe and timer is aligned to one horizon —
intraday, flat within a session. The stack: **1m** = entry trigger, **15m** =
structure + regime, **1h** = higher-timeframe bias (the trend classifier). Scans run
every 5 min; positions are expected to resolve within ~6h. (The earlier 4h bias was the
cause of perpetually "neutral" trends — a 4h read barely moves inside a ≤4h trade, so it
never committed to a direction. 1h commits.)

This is the **end-to-end thin slice**: one full pipeline proving the
architecture. It runs **keyless** out of the box — public Bybit REST needs no
API key, the AI trend classifier falls back to a rule-based classifier when no
Gemini key is set, and alerts print to the console when Telegram isn't
configured.

## Pipeline

```
Bybit market data ──▶ Regime Engine ──▶ AI Trend Classifier ──▶ S/R Engine
   (1m/15m/1h,          (rule-based:        (Gemini → fallback:    (swing pivots,
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
| **AI Trend Classifier** | "Which way is 1H momentum going?" | Gemini 2.5 Flash → Flash-Lite → EMA/ADX rule fallback. |
| **S/R Engine** | "Where are key horizontal support/resistance levels?" | Swing pivots, clustered, strength scored. |
| **Outcome Evaluator** | "Did active signals hit entry, TP, SL, or expire?" | 1-minute polling of ticker price against active outcomes in DB. |
| **Edge Monitor** | "Does an active signal's original edge still hold?" | 1-minute recompute of confidence/structure/trend; tracks `ACTIVE → EDGE_WEAKENING → INVALIDATED`. |
| **Trade Manager** | "What should the trader DO with this open trade right now?" | 1-minute assessment of every filled trade: trade health, rejection/decay/liquidity detection, adaptive stop suggestions, action-oriented alerts. |

A signal needs both to agree (e.g. `regime=ranging` **AND** `trend=bullish` →
`liquidity_sweep LONG` permitted).

### Strategy detectors

| Strategy | Regime Gate | Pattern |
|----------|-------------|---------|
| **momentum** | `trending`/`ranging`/`high_volatility` | Fast directional move (≥`min_move_pct` over `lookback_1m` 1m candles, volume-confirmed) — *rides* the move; blocked only if the 1h trend is strictly opposite |
| **liquidity_sweep** | `ranging` | Wick sweeps S/R level, then reclaims (bounce) |
| **trend_pullback** | `trending` | Price pulls back to S/R, then bounces in trend direction |
| **squeeze** | `high_volatility` | Extreme funding (percentile) + open interest shift — **disabled by default** (`squeeze.enabled`), counter-trend fade pending evidence |

When multiple detectors fire, the scanner selects the signal with the highest
**combined score** (`confidence × 0.6 + setup_quality × 0.4`).

**Stops are ATR-sized.** Every detector's structural stop is widened to at least
`risk.atr_sl_mult × ATR(15m)` (floored/capped by `min/max_sl_pct`), so a stop is never
left inside the noise — a flat 0.5% stop in a high-volatility regime gets run over instantly.

### Two scores per signal

- **Confidence** (0–100) — *market conditions*: funding extremity, OI z-score,
  volume percentile, regime alignment.
- **Setup Quality** (0–100) — *technical structure*: S/R level strength, engulf
  body ratio, HTF alignment, sweep wick ratio, structure intact.

### Active signal lifecycle

A signal is **stateful** after publication. Each `signal_outcomes` row tracks two
**independent** axes:

| Axis | States | Meaning |
|------|--------|---------|
| `status` (price) | `PENDING_ENTRY → ACTIVE → TP_HIT \| SL_HIT \| EXPIRED` | did price enter / hit TP/SL / expire (the **Outcome Evaluator**) |
| `edge_state` (edge) | `ACTIVE → EDGE_WEAKENING → INVALIDATED` | does the original thesis still hold (the **Edge Monitor**) |

- **Follow / Skip activation** (`lifecycle.require_follow`, default on, Telegram only).
  When enabled, an alert arrives with **Follow** / **Skip** buttons and is *not* tracked yet:
  - **Follow** creates the outcome and starts lifecycle/edge monitoring.
  - **Skip** records the decision and creates a silent **shadow** outcome (`followed=false`) —
    evaluated for price (counterfactual "would-have-won" data) but excluded from notifications,
    edge monitoring, the active-slot check, and the main analytics. Ignoring the alert tracks
    nothing.
  Console mode (or `require_follow: false`) keeps auto-tracking every signal as before.
- **One active signal per symbol.** While a symbol has an open *followed* row
  (`status IN (PENDING_ENTRY, ACTIVE)`), the scanner **suppresses** new signals for it —
  you get an *update*, never a duplicate. (DB-less mode has no registry, so the per-strategy
  cooldown is the fallback dedupe there.)
- **Every minute**, the edge monitor recomputes confidence, setup quality, funding/OI
  factors, structure, and trend alignment — storing them as `live_confidence` /
  `live_setup_quality` / `live_factors`. **Originals are immutable.**
- **Conservative invalidation**: a single failed condition (trend/regime alignment or
  structure) is only `EDGE_WEAKENING`. `INVALIDATED` requires ≥2 soft failures **or** a
  critical one (confidence at/below `lifecycle.invalidate_confidence_floor`). The bot
  **never auto-closes** — `INVALIDATED` is tracked, and the slot frees only when price resolves.
- **Telegram updates** (not duplicate signals) fire on edge-state changes or significant
  confidence moves, throttled by `lifecycle.update_*`:
  ```
  ⚠ SOL SHORT UPDATE          ⚠ SOL SHORT INVALIDATED
  Status: ACTIVE              Reason:
  Confidence: 93 → 78         - Structure broken
  Funding: 99% → 92%          - OI z-score reverted
  OI Z-score: -3.4 → -2.1     Confidence: 93 → 28
  Trade remains valid.
  ```
- **Edge evolution history** is appended to `signal_edge_updates` (write-gated by
  `lifecycle.edge_history_*` to bound row growth) so confidence decay / factor evolution
  can be analyzed later. Thresholds live under `lifecycle:` in `config/rules.yaml`.

Verify the edge state machine + message formatting offline (no DB) with `pnpm test:lifecycle`.

### Trade management (entries → complete trade management)

Once a trade **fills** (`status=ACTIVE`), the **trade manager** (`src/management/`)
re-scans the market every minute and manages it until exit — the goal is expectancy,
not just entries: protect profits, cut losses early, catch weakening momentum, adapt
to changing structure. The bot **only suggests; it never touches the exchange**.

The user-facing lifecycle maps onto the existing state machine (orthogonal
`management_state` column — `NONE → MONITORING → MANAGED`):

```
PENDING  = status PENDING_ENTRY        (plan delivered with the alert)
FILLED   = status ACTIVE               (manager picks it up within a minute)
ACTIVE   = ACTIVE + MONITORING         (scanned every 60s)
MANAGED  = ACTIVE + MANAGED            (≥1 action suggested)
EXITED   = TP_HIT | SL_HIT | EXPIRED | CLOSED
```

What ships with each **signal alert** (also persisted on the outcome row):

- **Management plan** — Base (entry/SL/TP), Protection (`+1R → breakeven`,
  `+1.5R → lock 30%`, volume-weakness partials), Aggressive (trail the runner with the
  regime-chosen method), and Emergency rules (opposite engulf / structure break /
  confidence floor → exit).
- **Expected-path probabilities** — `A: TP directly / B: retest then TP / C: SL hit`,
  integers summing to 100, recomputed live as the trade evolves.

What the manager computes **every minute** per filled trade (signal-sourced *and*
autodetected Bybit positions):

- **Trade health (0–100)** — weighted blend of structure / momentum / volume /
  trend-alignment / risk-protection (`management.health_weights`), classified
  `excellent (85+) / healthy (70+) / neutral (55+) / weak (40+) / exit candidate (<40)`.
- **Rejection detection** — repeated adverse wicks, failed breakouts, fading
  directional volume, weakening bodies, RSI divergence (≥2 signals → alert).
- **Momentum decay** — volume/ATR contraction, ADX decline, RSI divergence, MACD
  histogram weakening (≥2 → alert).
- **Liquidity events** — sweeps, stop hunts, and breakout traps around recent extremes
  on volume spikes, classified with/against the trade.
- **Adaptive stop suggestions** — regime-chosen method (`trending`=swing,
  `high_volatility`=ATR, `ranging`=structure, `low_volatility`=EMA), only when it
  meaningfully improves protection (`min_stop_improve_r`); never widens a stop.
- **Dynamic confidence** — the edge monitor's `live_confidence` rendered as
  `entry → current` in every report (the manager owns messaging for filled trades so
  one living Telegram message carries health + edge + actions).

**Alerts are action-oriented** — every event answers *what happened / why it matters /
what to do* — and conservatively throttled: a persisting condition alerts **once**
(latched until it clears), warning kinds respect `management.event_cooldown_min`, and
routine numbers refresh by editing the tracked message in place. Bybit position rows
keep their reconciler-owned live message (now enriched with health + suggested stop);
the manager sends event alerts for them and mirrors SL/TP edits made on the exchange.
Event history is appended to `trade_management_events` (write-gated heartbeats) for
later analysis. All knobs live under `management:` in `config/rules.yaml`; disable the
whole layer with `management.enabled: false`.

Verify detectors, stops, health, paths, plan, and the end-to-end assessment offline
(no DB, no network) with `pnpm test:management`.

### Outcome & edge analytics

The accumulated lifecycle data is turned into performance insight by one read-only query
engine (`src/analytics/`), surfaced three ways:

- **CLI** — `pnpm analytics` (add `-- --days=N`, `0` = all-time) prints a full report.
- **Telegram digest** — a scheduled compact summary (weekly by default; see
  `analytics.digest_every_hours`), pushed via the notifier.
- **HTTP** — `GET /analytics?days=N` on the health server returns the report as JSON.
- **Telegram commands** — in loop mode the bot also *listens* for:
  - `/scan zec` — scan **any** coin by name: tickers are normalized (`zec`/`BTC`/`wld` →
    the USDT perpetual), validated against Bybit's live instrument list (typos get
    "did you mean" suggestions; see `src/data/symbols.ts`), and symbols outside the
    watchlist work too (REST fallback when the WS feed doesn't stream them). The reply
    is a **decision briefing** — price, regime, 1h trend, S/R levels, every detector's
    verdict, and a clear verdict line (signal sent / gated / cooldown / already
    tracking / no setup) — so deciding to take or skip never requires reading logs.
    When a candidate setup exists, the briefing arrives **with the setup chart**
    (as its caption): gated/cooldown/already-tracking setups render the chart into
    the reply, and a gate-passing setup delivers it on the alert itself. No setup,
    no chart — a clean text "skip" instead.
  - `/scan` (no args, or `/scan all`) — scan the entire watchlist, one summary line each.
  - `/running` — tracked trades with health + live PnL and per-trade Details buttons.
    Details opens an **interactive trade card**: a 5-second summary (verdict like
    🟢 HOLD / 🟠 REDUCE / 🔴 EXIT, PnL with $ amount, confidence, SL → suggested SL,
    TP, expected-path odds) with `📋 Action` / `📊 Analysis` / `🛡 Risk` buttons that
    **edit the same message in place** (no scroll, no message spam); every section
    carries its sibling tabs plus `⬅ Back` to the summary.
  - `/recent [n]` — an **interactive evaluation card** over the last n closed trades
    (default 10): the root scoreboard shows the streak, net R, win rate, $ PnL, and
    best/worst trade, with `📋 View Trades` (numbered list, one button per trade →
    result card → `🧠 Analysis`) and `📊 Performance` (net R over the last 10/30/90
    trades, win rate, profit factor, expectancy, avg win/loss). Like the trade card,
    every press edits the same message in place — one card, `⬅ Back` everywhere.
  - `/status` (open signals), `/analytics [days]` (digest on demand).

  Commands are accepted only from the configured `TELEGRAM_CHAT_ID`. Long-polling runs
  in the one loop-mode process, so don't run a second loop-mode instance against the
  same bot token while it's live — Telegram allows only one `getUpdates` poller per bot.
  (Send-only scripts like `pnpm test:telegram` don't poll, so they're fine.)

Metrics: overall + per-strategy/direction/symbol/regime win-rate and durations;
**confidence calibration** (actual win-rate per `original_confidence` bucket);
**edge-monitor validation** (win-rate by terminal edge state + confidence decay in winners
vs losers); and **factor effectiveness** (funding/OI in winners vs losers). All windows
filter on `opened_at`; win-rate counts only resolved (`TP_HIT`/`SL_HIT`) outcomes.

Validate the formatters offline (no DB) with `pnpm test:analytics`.

### Backtesting

Before trusting a detection change with live money, replay it over history:

```bash
pnpm backtest -- --symbols=BTCUSDT,ETHUSDT --days=14 --step=5
```

The harness (`src/backtest/`) is **read-only and isolated** — it reuses the *real* detectors,
regime engine, S/R, and scoring (deterministic: EMA/ADX trend, no Gemini, no DB), rebuilds a
`MarketContext` at every 5-min step from fetched 1m/15m/1h + funding/OI, and simulates each
signal's outcome on 1m highs/lows. It reports per-strategy **fill-rate, win-rate, expectancy
(avg R), profit factor, drawdown**, and **confidence calibration**. Flags: `--days`, `--step`,
`--symbols`, `--fee_pct`, `--slippage_pct`, `--json`.

**Assumptions (results are directional, not exact):** 1m-granularity fills with **SL-first on an
ambiguous candle** (pessimistic); fees + slippage deducted; funding/OI REST granularity is coarser
than 15m so percentile windows are approximate; trend uses EMA/ADX only (live Gemini may differ);
no liquidity/partial-fill modeling. Needs Bybit public REST reachable (runs on the VPS or locally).
Validate the fill model offline with `pnpm test:backtest`.

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

# Performance analytics report (requires DATABASE_URL)
pnpm analytics                 # default window (30d)
pnpm analytics -- --days=0     # all-time

# Verbose decision logging
LOG_LEVEL=debug pnpm scan:once

# Test chart rendering (generates test-chart.png using mock sweep scenario)
pnpm test:chart
```

`--mock` generates synthetic candles crafted to land in a ranging regime with a
bullish 1H trend and a fresh support sweep+reclaim — i.e. a textbook
`liquidity_sweep LONG` — so you can see the full pipeline produce an alert
without waiting for live conditions to line up.

`--mock --mock-scenario=pullback` generates a trending regime with a bullish
1H trend and a pullback-to-support pattern — producing a `trend_pullback LONG`.

`--mock --mock-scenario=squeeze` generates a high-volatility regime with a bullish/bearish
1H trend and extreme funding/OI deviations — producing a `squeeze LONG/SHORT`.

Mock mode automatically disables external services (Gemini, Telegram, Redis,
Postgres) so tests are fully isolated and deterministic.

## Configuration

- `config/watchlist.yaml` — symbols, per-asset scan interval, asset class,
  per-symbol confidence overrides, global gates (min confidence/quality/RR,
  cooldown).
- `config/rules.yaml` — regime thresholds, trend tiers, scoring weights, ATR stop
  sizing (`risk:`), momentum detector (`momentum:`), squeeze toggle (`squeeze.enabled`),
  signal lifecycle thresholds (`lifecycle:`), trade management (`management:`),
  analytics/digest cadence (`analytics:`), retention policy.
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

   Tables created: `metric_history`, `signals`, `regime_log`, `signal_outcomes`,
   `signal_edge_updates`, `trade_management_events`. All lifecycle/analytics/
   interactive/management columns (incl. `signals.decision`, `signal_outcomes.followed`,
   `signal_outcomes.management_state`) are additive, so `pnpm db:push` applies them to
   an existing database without data loss.

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
pnpm chrome:install         # download Chrome for chart rendering (see note below)
pnpm db:push                # if DATABASE_URL is set — reconcile schema

pm2 start ecosystem.config.cjs
pm2 save                    # persist the process list
pm2 startup                 # print the command to enable PM2 on boot, then run it
```

### Continuous deployment

`.github/workflows/deploy.yml` runs on every push to `main`: it typechecks, then
SSHes into the VPS and runs `scripts/deploy.sh` (`git reset --hard origin/main` →
`pnpm install` → `pnpm chrome:install` → `drizzle-kit push` → `pm2 reload` →
verify `/health`). A red health check fails the deploy.

#### Chart rendering needs a browser

`puppeteer-core` does **not** download a browser, so the bot needs a Chrome to
render chart images. Without one, `renderChart()` returns `null` and alerts go
out **text-only** (no image attached). `pnpm chrome:install` downloads
Chrome-for-Testing into the puppeteer cache (`~/.cache/puppeteer`), and the
renderer auto-discovers it there — the deploy runs this for you (a failure is
non-fatal: the bot still sends text alerts). The renderer resolves a browser in
this order: `CHROME_PATH` → system Chrome/Chromium → puppeteer cache.

On a **bare Linux server**, the downloaded Chrome also needs its shared libraries:

```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 \
  libasound2 libxshmfence1 libgbm1 fonts-liberation
```

Alternatively, install system Chrome (`apt-get install -y google-chrome-stable`,
which pulls those deps) and either let auto-detection find it or set `CHROME_PATH`. Schema sync uses `push` (not migration files);
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

The same server also exposes `GET /analytics?days=N` (the performance report as JSON;
`503` when no database is configured):

```bash
curl -s 'localhost:3000/analytics?days=30' | jq
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
  risk.ts                   ATR-based stop-loss sizing (widenStopToAtr)
  scoring.ts                confidence + setup_quality
  notify.ts                 Telegram/console + explainability formatter
  types.ts                  shared domain types
  chart/
    renderer.ts             Puppeteer-core + system Chrome + Lightweight Charts PNG generator
    path-calculator.ts      per-strategy expected-path overlay (markers, zones, projection)
    template.html           self-contained HTML/JS charting template
  data/
    bybit.ts                public v5 REST: klines, ticker, funding, OI
    market.ts               assembles per-symbol MarketContext
    mock.ts                 deterministic offline data (sweep + pullback scenarios)
  db/
    schema.ts               Drizzle schema: metric_history, signals, regime_log, signal_outcomes, signal_edge_updates, trade_management_events
    index.ts                Postgres client (graceful degradation)
    accumulate.ts           recordMetrics, recordSignal, recordRegime, outcomes, management & retention
  outcome/
    outcome-tracker.ts      price lifecycle: evaluates open outcomes against live tickers every minute
  lifecycle/
    edge.ts                 edge recompute (computeEdgeSnapshot) + conservative classifyEdgeState
    monitor.ts              edge lifecycle monitor: live scores, edge state, throttled Telegram updates
  management/
    detectors.ts            rejection / momentum-decay / liquidity-event detection (pure math)
    health.ts               trade health score (structure/momentum/volume/trend/risk components)
    stops.ts                regime-aware adaptive stop suggestions (swing/ATR/EMA/structure)
    paths.ts                expected-path probabilities (TP direct / retest / SL)
    plan.ts                 management-plan generator (Base/Protection/Aggressive/Emergency)
    assess.ts               per-minute trade assessment (combines all of the above)
    manager.ts              the 60s manager loop: throttled alerts, history, persistence
  analytics/
    queries.ts              read-only win-rate / calibration / edge-validation / factor aggregations
    report.ts               assembles AnalyticsReport + text (CLI) and digest (Telegram) formatters
  backtest/
    engine.ts               replays history through the real detectors (read-only reuse)
    simulate.ts             1m-granularity fill model (SL-first, fees+slippage)
    report.ts               per-strategy expectancy / win-rate / calibration report
    run.ts                  CLI entry (pnpm backtest)
  regime/engine.ts          rule-based regime classifier
  ai/trend-classifier.ts    3-tier trend classifier (Gemini → fallback)
  strategy/
    sr-engine.ts            swing pivots → clustering → strength scoring
    momentum.ts             fast directional move / breakout detector (ATR stop)
    liquidity-sweep.ts      sweep+reclaim detector
    trend-pullback.ts       pullback-to-S/R + bounce detector
    squeeze.ts              extreme funding + OI changes detector (disabled by default)
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
- **Prev Day/Week H/L S/R source** (high-weight S/R levels from REST).

Recently landed (post-MVP):
- **Trade management layer** — the 1-minute manager turns the bot from entry-only into complete trade management: trade health, rejection/decay/liquidity detection, adaptive stops, management plans, and expected-path probabilities (see [Trade management](#trade-management-entries--complete-trade-management)).
- **Expected-path chart overlay** — per-strategy `chart/path-calculator.ts` adds entry/sweep/reclaim markers, a shaded watch zone, and a dotted projection from entry to TP, computed on the rendered candle series.
- **Bybit WebSocket feed** — streamed candles/ticker with REST seeding + reconnect (`MARKET_FEED=ws`).
- **BullMQ scheduler** — durable repeatable jobs when `REDIS_URL` is set, `setInterval` fallback otherwise.
- **Adaptive-threshold history accumulation** — historical backfill into `market_history`.
- **CI/CD, health checks, and monitoring** — see [Deployment](#deployment-vps--pm2--cicd).
