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
                              Strategy Detector  ──▶  Scoring  ──▶  Gates  ──▶  Alert
                              (liquidity_sweep)      (confidence +    (conf/quality/    (Telegram
                                                      setup_quality)   RR/cooldown)       or console)
```

Two components answer **different** questions and never override each other:

| Component | Question | How |
|-----------|----------|-----|
| **Regime Engine** | "What strategy fits current conditions?" | Pure math (ADX, ATR percentile, EMA spread). No AI. |
| **AI Trend Classifier** | "Which way is 4H momentum going?" | Gemini 2.5 Flash → Flash-Lite → EMA/ADX rule fallback. |

A signal needs both to agree (e.g. `regime=ranging` **AND** `trend=bullish` →
`liquidity_sweep LONG` permitted).

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
pnpm exec tsx src/index.ts --once --mock

# Continuous loop — per-asset interval from watchlist.yaml
pnpm scan

# Verbose decision logging
LOG_LEVEL=debug pnpm scan:once
```

`--mock` generates synthetic candles crafted to land in a ranging regime with a
bullish 4H trend and a fresh support sweep+reclaim — i.e. a textbook
`liquidity_sweep LONG` — so you can see the full pipeline produce an alert
without waiting for live conditions to line up.

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

Everything degrades gracefully — a missing key just disables that layer.

## Layout

```
src/
  index.ts                  entry point, scheduling, --once/--mock flags
  scanner.ts                per-symbol pipeline orchestration + gates
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
    mock.ts                 deterministic offline data
  regime/engine.ts          rule-based regime classifier
  ai/trend-classifier.ts    3-tier trend classifier (Gemini → fallback)
  strategy/
    sr-engine.ts            swing pivots → clustering → strength scoring
    liquidity-sweep.ts      sweep+reclaim detector
```

## What's NOT in this MVP (next sprints)

Per the blueprint, deferred to later sprints: `trend_pullback` and `squeeze`
detectors, Postgres/Drizzle persistence + retention cleanup job, BullMQ workers,
Bybit WebSocket (currently REST polling), chart rendering + R2 upload, and the
adaptive-threshold history accumulation. The architecture has seams for all of
them (pluggable data provider, cache abstraction, per-strategy detectors).
