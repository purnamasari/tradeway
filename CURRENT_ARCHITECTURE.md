# Current Architecture Audit

Audited 2026-06-12 against `main`/`feat/research-quant`. Scope: the production
signal engine (`src/`), not the research harness (`research/`).

## 1. Flows as built

### 1.1 Scanner flow

```
index.ts (PeriodicTask per symbol, scan_interval minutes)
  └─ scanner.ts scanSymbol()
       ├─ getContext()                    — REST or WS feed → MarketContext (1m/15m/1h candles, funding, OI)
       ├─ hydrateContextHistory()         — DB percentile/z-score windows folded into ctx
       ├─ classifyRegime()                — 15m ADX/ATR-pct/EMA-spread → regime + allowedStrategies
       ├─ classifyTrend()                 — Gemini 2-tier → EMA/ADX fallback, cached
       ├─ buildSR()                       — 15m support/resistance snapshot
       ├─ 4 HARD-CODED detectors          — liquidity_sweep, trend_pullback, squeeze, momentum
       ├─ pick best by 0.6·confidence + 0.4·setup_quality
       ├─ gates: min_confidence, min_setup_quality, min_rr
       ├─ one-active-signal-per-SYMBOL check (signal_outcomes)
       ├─ cooldown (cache key per symbol+strategy)
       ├─ buildManagementPlan() + estimatePaths() attached to Signal
       ├─ renderChart() → PNG
       └─ recordSignal() → notifier.send() → createOutcome() (or Follow button creates it)
```

### 1.2 Signal generation flow

Each detector (`src/strategy/*.ts`) is a free function
`(ctx, regime, trend, sr, rules) → { signal: Signal | null, reason }`. The
`Signal` shape (`src/types.ts`) is the universal currency: every downstream
consumer (DB, chart, Telegram, lifecycle, management) reads its fields
directly. It REQUIRES: `strategy: StrategyKind` (closed 4-member union),
`confidence`/`setup_quality`/`score_breakdown` (funding percentile, OI z-score,
sweep wick ratio…), fixed `tp`, `rr`, and an S/R `snapshot`.

### 1.3 Trade lifecycle flow

One DB table, `signal_outcomes`, is simultaneously the signal tracker and the
position store. Price lifecycle: `PENDING_ENTRY → ACTIVE → TP_HIT | SL_HIT |
EXPIRED` (plus `CLOSED` for reconciled Bybit positions). Three independent
60-second loops operate on the same rows:

- **outcome-tracker** (`src/outcome/outcome-tracker.ts`) — owns price exits.
  Compares the latest ticker price to the static `entry_low/high`, `sl`, `tp`
  columns and `expires_at`.
- **edge monitor** (`src/lifecycle/monitor.ts`) — recomputes the SMC
  confidence score for the open signal, classifies
  `ACTIVE → EDGE_WEAKENING → INVALIDATED`, edits the Telegram alert in place.
  Never closes a trade.
- **trade manager** (`src/management/manager.ts`) — health scoring, event
  detection (rejection, decay, stop hunt), adaptive stop **suggestions**.
  Suggests only; never mutates the tracked `sl`.

### 1.4 Position tracking

`signal_outcomes` rows with `source='signal'` (bot signals, real or shadow)
or `source='bybit'` (reconciler-autodetected real positions, `strategy:
'manual'`, exited only when they disappear from the exchange). Entry/SL/TP are
written once at creation; the only mutable trade fields are lifecycle
bookkeeping (edge, management, notification throttles). There is **no
strategy-owned mutable state** on a position (no highest-close, no bar age).

### 1.5 Exit handling

Exclusively fixed-level + TTL: static `sl`/`tp` columns checked against the
**last ticker price** once a minute, and `expires_at` derived from
`ENTRY_TTL`/`OUTCOME_TTL` — compile-time `Record<StrategyKind, ms>` constants
in `src/types.ts` (6h/4h outcome horizons). Intrabar extremes between polls
are missed. The management layer computes trailing-stop *suggestions*
(`management/stops.ts`) but they only reach the user as text.

### 1.6 Telegram notification flow

`src/notify.ts` (1,449 lines) renders everything: alert (`formatAlert`), edge
updates, trade reports, outcome closes, /status /running /recent cards. All
formatters take `Signal` or `OutcomeRow` directly and print SMC-specific
fields (confidence, setup quality, RR, S/R snapshot, funding percentile, plan
rules). Inbound commands (Follow/Skip/scan/…) are handler callbacks wired
from `index.ts`. The `Notifier` interface is the only seam — but its methods
are typed to `Signal`/`OutcomeRow`/`SignalUpdate`, not to a generic event.

## 2. Coupling points

| # | Coupling | Where | Effect |
|---|---|---|---|
| C1 | `StrategyKind` closed union | `types.ts`, DB rows, `ENTRY_TTL`/`OUTCOME_TTL`, notify, edge, paths | Adding any strategy = edit core types + every consumer |
| C2 | Detector call sites hard-coded | `scanner.ts:192-197`, duplicated in `backtest/engine.ts` | New strategy = edit the scanner (twice) |
| C3 | Gates assume SMC scoring | `scanner.ts` (min_confidence / min_setup_quality / min_rr) | A strategy without confidence/quality/fixed-TP cannot pass or be ranked |
| C4 | Regime engine knows strategies | `regime/engine.ts` `ALLOWED` map returns `StrategyKind[]` | Core market classification hardcodes which strategies may run |
| C5 | `Signal` is the universal currency | chart, DB payload, notify, plan, paths | Every field is assumed present; `tp`, `rr`, `score_breakdown` are mandatory |
| C6 | One open trade per **symbol** | `scanner.ts` + `fetchOpenOutcomeForSymbol` | Two strategies cannot hold the same symbol; portfolio semantics impossible |
| C7 | TTLs are strategy-keyed constants | `types.ts`, used by `db/accumulate.ts` + `outcome-tracker.ts` | Horizons are core knowledge, not strategy knowledge |
| C8 | Edge monitor recomputes SMC scores for ALL strategies | `lifecycle/edge.ts` | A non-SMC strategy would be spuriously `INVALIDATED` by funding/OI/structure checks it never used |
| C9 | Notification formats read raw Signal/OutcomeRow | `notify.ts` | Message content cannot vary by strategy; reasons are derived from `score_breakdown` |
| C10 | `paths.ts` special-cases `strategy === "momentum"` | `management/paths.ts:47` | Per-strategy behavior leaking into shared estimator |
| C11 | No position sizing anywhere | `risk.ts` is stop *widening* only | "Risk" currently means SL placement, a strategy concern; sizing doesn't exist |
| C12 | `detected_at: Date.now()` inside detectors | all 4 detectors | Non-deterministic; one reason backtest/live can diverge |

## 3. Assumptions tied to SMC / reversal logic

1. **Every trade has a fixed TP** — `tp NOT NULL` in schema, `rr` gate, chart
   reward band, path probabilities (`tp_direct/retest_then_tp/sl_hit`), plan
   triggers in R-to-TP terms.
2. **Entries are limit-zone retests** (`entry_low/high` band, PENDING_ENTRY
   wait state, entry TTL ≤ 1h) — reversal thinking. Breakout strategies enter
   on/near close of the trigger bar.
3. **Setups decay in hours** — outcome TTL 4–6h ("flat within a session").
4. **Signal quality = market-conditions score** (funding percentile, OI
   z-score, volume percentile) + **structure score** (S/R strength, engulf
   ratio, sweep wick). Both meaningless for a Donchian/momentum system.
5. **The thesis can be re-scored live** (edge monitor) using those same SMC
   factors — H18's thesis is "the channel broke with momentum"; it cannot
   weaken by funding percentile.
6. **Regime decides which strategies exist** (`ALLOWED` map) — H18 does its
   own regime gate (skip-ranging) inside the strategy.

## 4. What blocks trend-following strategies (H18 family)

- **Horizon**: 14-day holds are impossible — `OUTCOME_TTL` maxes at 6h and is
  a closed record (C7); `expires_at` is enforced by the tracker.
- **No-TP trades are unrepresentable**: schema `tp` is `NOT NULL` + `rr` gate
  (C3, C5); the whole notification/chart/path stack assumes a target.
- **Entry semantics**: H18 enters at/near the breakout close (2h TTL band).
  Expressible, but PENDING_ENTRY assumes a *retest* and the band columns are
  repurposed at best.
- **Strategy identity**: `strategy` column would carry an unknown kind —
  every `Record<StrategyKind, …>` lookup falls back or crashes (C1).
- **Concurrency**: H18 + SMC on the same symbol is blocked by the per-symbol
  slot (C6).
- **Edge monitor** would invalidate H18 trades using SMC scores (C8).

## 5. What blocks trailing-stop strategies

- **No mutable stop**: `sl` is written once; nothing updates it (the manager
  only *suggests*). A chandelier trail needs `stopPrice` to ratchet.
- **No per-position strategy state**: trailing needs `highestClose` (or
  anchor) persisted per position across process restarts; no column exists
  (the `state` has to be strategy-defined — SMC wants `sweepLevel`, H18 wants
  `highestClose`).
- **No bar-close semantics**: exits are last-price polls; a close-anchored
  trail and bar-age time stops need "15m bar closed" events with bar data,
  not ticker snapshots.
- **No strategy exit hook**: the exit decision is hardwired to
  `price vs sl/tp/expiry`; a strategy cannot say "exit: trail touched" or
  "exit: opposite channel break".

## 6. What already helps (keep, don't rebuild)

- `Notifier` is already an interface with console/Telegram implementations —
  the seam exists, only the payload types are wrong.
- `getContext` is already pluggable (REST / WS / mock), and the scheduler
  abstracts BullMQ/setInterval.
- The three 60s loops have clean ownership boundaries (price exits vs thesis
  vs management) — the target architecture can preserve this split.
- `signal_outcomes` already carries JSONB columns for lifecycle blobs — adding
  a `strategy_state` JSONB and nullable `tp` is schema evolution, not a new
  store.
- The research validation framework (`research/validation/strategy.ts`)
  already proved the plug-in strategy shape works for backtesting; the
  production interface below is its live-side mirror.
