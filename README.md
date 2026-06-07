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
                               trend_pullback)        setup_quality)   RR/cooldown)       or console)
```

Two components answer **different** questions and never override each other:

| Component | Question | How |
|-----------|----------|-----|
| **Regime Engine** | "What strategy fits current conditions?" | Pure math (ADX, ATR percentile, EMA spread). No AI. |
| **AI Trend Classifier** | "Which way is 4H momentum going?" | Gemini 2.5 Flash → Flash-Lite → EMA/ADX rule fallback. |

A signal needs both to agree (e.g. `regime=ranging` **AND** `trend=bullish` →
`liquidity_sweep LONG` permitted).

### Strategy detectors

| Strategy | Regime Gate | Pattern |
|----------|-------------|---------|
| **liquidity_sweep** | `ranging` | Wick sweeps S/R level, then reclaims (bounce) |
| **trend_pullback** | `trending` | Price pulls back to S/R, then bounces in trend direction |

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

# Continuous loop — per-asset interval from watchlist.yaml
pnpm scan

# Verbose decision logging
LOG_LEVEL=debug pnpm scan:once
```

`--mock` generates synthetic candles crafted to land in a ranging regime with a
bullish 4H trend and a fresh support sweep+reclaim — i.e. a textbook
`liquidity_sweep LONG` — so you can see the full pipeline produce an alert
without waiting for live conditions to line up.

`--mock --mock-scenario=pullback` generates a trending regime with a bullish
4H trend and a pullback-to-support pattern — producing a `trend_pullback LONG`.

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
  - `REDIS_URL` → shared cache (else in-process)
  - `DATABASE_URL` → Postgres persistence for metric history and signals (else disabled)

Everything degrades gracefully — a missing key just disables that layer.

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

   Tables created: `metric_history`, `signals`, `regime_log`.

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
  data/
    bybit.ts                public v5 REST: klines, ticker, funding, OI
    market.ts               assembles per-symbol MarketContext
    mock.ts                 deterministic offline data (sweep + pullback scenarios)
  db/
    schema.ts               Drizzle schema: metric_history, signals, regime_log
    index.ts                Postgres client (graceful degradation)
    accumulate.ts           recordMetrics, recordSignal, recordRegime
  regime/engine.ts          rule-based regime classifier
  ai/trend-classifier.ts    3-tier trend classifier (Gemini → fallback)
  strategy/
    sr-engine.ts            swing pivots → clustering → strength scoring
    liquidity-sweep.ts      sweep+reclaim detector
    trend-pullback.ts       pullback-to-S/R + bounce detector
config/
  watchlist.yaml            symbols, scan intervals, asset classes
  rules.yaml                thresholds, weights, retention policy
drizzle.config.ts           Drizzle Kit config for schema management
```

## What's NOT in this MVP (next sprints)

Per the blueprint, deferred to later sprints: `squeeze` detector (needs metric
history accumulation first), Bybit WebSocket (currently REST polling), BullMQ
workers, chart rendering + R2 upload, retention cleanup job, and adaptive-threshold
history accumulation. The architecture has seams for all of them (pluggable data
provider, cache abstraction, per-strategy detectors).
