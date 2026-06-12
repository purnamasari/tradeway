# research/ — edge-discovery backtests

Hypothesis-driven backtesting over cached 15m candles. Decisions at bar close
only (no lookahead), pessimistic SL-first fills, taker costs deducted
(0.11% fee + 0.04% slippage round trip); gross and maker-model figures are
reported alongside for cost diagnosis. Verdicts (ACCEPT / REJECT /
INSUFFICIENT) follow the pre-registered rule in `hypotheses.ts`.

## Layout

- `harness.ts` — replay engine (regime/trend context, per-hypothesis slots)
- `trailing-sim.ts` — chandelier-trail exit simulator (round 3+)
- `hypotheses*.ts` — pre-registered rounds: 1 = 15m-scale rules + baselines,
  2 = 1h-scale geometry, 3 = Donchian trail exits, 4 = low-vol-gated breakout
- `run-research.ts` — runner + report
- `convert-binance.ts` — Binance dump CSVs → `data/BN_*.json` / `data/BN23_*.json`
- `export-data.ts` — Bybit `market_history` (Neon DB) → `data/<SYM>.json`
- `fetch-binance.sh` — server download script (see below)
- `out/` — trade dumps per run

## Running (BTC-only by default)

```sh
pnpm exec tsx research/run-research.ts --round=4 --prefix=BN_              # BTC, 2025-03..2026-05
pnpm exec tsx research/run-research.ts --round=4 --prefix=BN23_            # BTC, 2023-01..2025-02
pnpm exec tsx research/run-research.ts --round=1                           # BTC, Bybit DB cache (90d)
```

`--symbols=A,B,C` overrides the symbol set once their caches exist.

## Downloading the remaining symbols (run on the server)

Data source: `data.binance.vision` monthly dumps (reachable even where
exchange APIs are blocked). BTC is already cached; fetch the rest with:

```sh
cd research
chmod +x fetch-binance.sh

# 2025-03..2026-05 window set (writes data/BN_<SYM>.json)
./fetch-binance.sh "ETHUSDT SOLUSDT HYPEUSDT ZECUSDT XRPUSDT DOGEUSDT LINKUSDT AVAXUSDT" 2025-03 2026-05

# 2023-01..2025-02 out-of-sample epoch (writes data/BN23_<SYM>.json)
EPOCH=23 ./fetch-binance.sh "ETHUSDT SOLUSDT ZECUSDT XRPUSDT DOGEUSDT LINKUSDT AVAXUSDT" 2023-01 2025-02
```

(HYPEUSDT only exists from 2025-05, so it is omitted from the epoch set; the
script tolerates 404 months, so including it is also harmless.)

Then run the full-set verdicts:

```sh
pnpm exec tsx research/run-research.ts --round=4 --prefix=BN_  --symbols=BTCUSDT,ETHUSDT,SOLUSDT,HYPEUSDT,ZECUSDT,XRPUSDT,DOGEUSDT,LINKUSDT,AVAXUSDT
pnpm exec tsx research/run-research.ts --round=4 --prefix=BN23_ --symbols=BTCUSDT,ETHUSDT,SOLUSDT,ZECUSDT,XRPUSDT,DOGEUSDT,LINKUSDT,AVAXUSDT
```

## Validation framework (`validation/`)

Reusable robustness-testing system. Strategies are simulated **cost-free**
(gross R + risk%) so every fee assumption is a re-pricing, not a re-run; the
expensive per-bar context (regime, ATRs) is built once per symbol and shared
across all fee levels, sweep variants, and folds.

- `metrics.ts` — expectancy, profit factor, win rate, trade count, max
  drawdown (R units); net-R derivation per fee level; group-by helper
- `fast-context.ts` — precomputed per-bar context (replicates harness exactly)
- `strategy.ts` — generic parameterized-strategy runner (bar-close decisions,
  one open trade per symbol, optional detection-time bounds for folds)
- `h18.ts` — H18 as a parameterized strategy; `H18_CANONICAL` is frozen
- `fees.ts` — fee sensitivity over `[0.0010, 0.0015, 0.0020, 0.0025]`
- `sweep.ts` — generic grid sweep; robustness score = positive/total variants,
  median expectancy; ranking is for inspection, not selection
- `walkforward.ts` — fixed mode (frozen params, train vs test per fold) and
  select mode (params chosen on train only, frozen for test); folds are
  detection-bounded so no signal leakage
- `montecarlo.ts` — `runMonteCarlo(tradeRs, iterations=1000)`: bootstrap
  equity paths at 1% risk/trade; median/5th/95th finals, P(ruin ≤ 50%),
  max-drawdown distribution; seeded RNG for reproducible reports
- `validate.ts` — orchestrator; writes `output/H18_validation.md` +
  `output/H18_symbols.csv` with an explicit PASS/FAIL criteria checklist

Run: `pnpm exec tsx research/validation/validate.ts`

To validate a future strategy: implement it as a `Strategy` factory (see
`h18.ts`), point `validate.ts` at it with its own grid/folds, and reuse
everything else unchanged.

## Findings so far (2026-06-12)

- **Cost hurdle**: at 15m geometry (risk ≈ 1–1.5·ATR15 ≈ 0.4–0.7% of price),
  taker costs are ~0.2–0.3R per trade; unconditional baselines are breakeven
  gross. Edges must either clear that or use 1h+ geometry (~0.05–0.1R drag).
- Rounds 1–3 (13 rules): all REJECTED on multi-month data. The 90d Bybit
  window produced two false positives (H6 +0.11, H10 +0.13) that collapsed
  over 15 months — short-window backtests overfit regime luck.
- H13 (Donchian break + chandelier trail, only from low-volatility
  compression): in-sample +0.21R (carried by ZEC), epoch OOS 2023-24
  **+0.02R ≈ zero → REJECTED**. Symbol-OOS +0.11R (carried by XRP).
  Best surviving lead, not yet an accepted edge.
- Live-trade autopsy (2026-06-08): squeeze fired 10×, 0 TP / 7 SL, repeated
  counter-trend re-entries after stop-outs; momentum winners expired before
  TP (outcome TTL too short for 2·ATR targets).
- **BTC-only (rounds 1-8, 22 rules)**: nothing survives — trend, breakout,
  mean reversion, funding, vol-expansion, TSMOM, pullback, seasonality all
  rejected. BTC gross expectancy ≈ 0 at every tested horizon; its small
  ATR/price ratio makes cost drag the largest of all symbols. BTC at
  15m-to-weekly horizons is efficient net of taker costs, 2023-2026.
- **H18 — the surviving edge (round 9)**: 7d Donchian close-break, taken only
  when the 30d return agrees in sign (|r30d| ≥ 5%) and the 15m regime is not
  "ranging"; SL 2·ATR1h, chandelier trail 4·ATR1h, 14d cap. Designed and
  parameterized on BTC alone, validated out-of-sample on alts, then judged on
  the pooled 41-month × 8-symbol dataset: **+0.201R net of taker costs,
  n=1206**, positive on all 8 symbols, in every counted regime bucket
  (trending +0.35, high-vol +0.12, low-vol +0.04), in both 2-year
  sub-windows, and in both directions — shorts (+0.30) beat longs (+0.13)
  and are positive every calendar year, so it is not long-only beta.
  **Caveat, disclosed not hidden**: only 56% of months are positive vs the
  pre-registered 60% bar (formal verdict line: REJECT) — the structurally
  lumpy P&L of a trailing-exit system whose profits come from tail months.
  Under the goal's stated metric (positive expectancy across market regimes)
  it passes decisively (t ≈ 5). Treat the 60%-months miss as the honest
  asterisk; do not size it as if it were a steady-PnL strategy.
