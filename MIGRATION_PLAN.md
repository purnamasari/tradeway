# Migration Plan: Strategy-Agnostic Execution Architecture

Companion to `CURRENT_ARCHITECTURE.md`. Target shape:

```
Market → Strategy Engine → Position Engine → Risk Engine → Notification Engine
```

where strategies are plug-ins and the core knows **no** strategy vocabulary
(no SMC, Donchian, momentum, BOS, FVG).

## Target architecture

### Module layout (`src/engine/`)

```
src/engine/
  types.ts      — StrategyContext, EntryDecision, ExitDecision, shared primitives
  strategy.ts   — Strategy interface + StrategyRegistry (plug-in point)
  position.ts   — Position model + PositionStore abstraction
  exit.ts       — Exit engine: interprets exit primitives, applies strategy updates
  risk.ts       — Risk engine: sizing models (fixed %, fixed size, vol-target)
  notify.ts     — Notification abstraction: generic strategy-attributed events
  index.ts      — barrel
```

### Strategy interface (the only thing a strategy implements)

```ts
interface Strategy {
  id: string;                                          // e.g. "H18", "SMC_V2"
  evaluateEntry(ctx: StrategyContext): EntryDecision;  // bar-close decision
  evaluateExit(ctx: StrategyContext, position: Position): ExitDecision;
  updateState(ctx: StrategyContext, position: Position): PositionState;
}
```

- `EntryDecision` is either `{ enter: false, reason }` or an `EntryIntent`:
  side, entry zone, initial stop, optional target, optional deadlines
  (entry/hold), human-readable `reasons: string[]`, initial `state`.
- `ExitDecision` is a closed set of **primitives** the exit engine executes:
  `hold` / `exit_market` / `move_stop` / `set_target` — plus the standing
  stop/target/time exits the position already carries. Strategy-specific
  logic ("opposite 7d channel break", "BOS against position") lives inside
  `evaluateExit`, which simply returns a primitive.
- `updateState` returns the strategy's own `PositionState`
  (`Record<string, unknown>`): `{ highestClose }` for H18, `{ sweepLevel }`
  for SMC. The core persists it opaquely (JSONB) and hands it back.
- Horizon knowledge (entry TTL, max hold) moves from core constants
  (`ENTRY_TTL`/`OUTCOME_TTL` records) into the strategy's `EntryIntent`.

### Position engine

Owns the position lifecycle and is the only writer of position rows:

```ts
interface Position {
  id: string;
  strategyId: string;            // replaces the closed StrategyKind union
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;             // MUTABLE — trailing ratchets it
  targetPrice: number | null;    // optional — no-TP strategies are first-class
  qty: number | null;            // sized by the risk engine (null = alert-only)
  openedAt: number;
  ageBars: number;               // bar-close driven, enables time stops
  entryDeadline / maxHoldUntil;  // strategy-provided, not core constants
  status: PENDING_ENTRY | OPEN | closed states;
  state: Record<string, unknown>; // strategy-specific, persisted opaquely
}
```

Concurrency key is **(symbol, strategyId)** — H18 and SMC can hold the same
symbol independently. Decision cadence is **bar close** (15m base): on each
closed bar the engine calls `updateState` → `evaluateExit` for open
positions and `evaluateEntry` for free slots. Between bars, a cheap
price-tick safety check enforces the standing `stopPrice`/`targetPrice` so a
fast move is not missed by a 15m cadence.

### Exit engine

Executes, in priority order: strategy `exit_market` > stop breach > target
touch > entry deadline > max-hold expiry. Applies `move_stop` with
ratchet-only semantics (a trailing stop never loosens) and `set_target`.
Covers: fixed stop, fixed TP, trailing stop, time stop, strategy-defined
exit — with zero strategy names in core code.

### Risk engine

Strategies emit signals only; sizing is a separate, configurable policy:

```ts
interface RiskEngine {
  size(intent: EntryIntent, account: AccountState): RiskDecision;
}
```

Provided models: `fixedFractionRisk` (risk % of equity ÷ stop distance),
`fixedNotional`, `volatilityTarget` (size ∝ target vol / realized vol). A
`RiskDecision` can also veto (qty 0, reason) — e.g. max concurrent positions,
max exposure per symbol. The current bot is alert-only, so the default model
runs in "advisory" mode: sizes are computed and displayed, never executed.

### Notification engine

The notifier consumes **generic strategy-attributed events**, not `Signal`:

```ts
interface NotificationEvent {
  kind: "entry" | "exit" | "stop_moved" | "position_update" | "info";
  strategyId: string;
  symbol: string;
  side?: "LONG" | "SHORT";
  headline: string;        // e.g. "LONG BTCUSDT"
  reasons: string[];       // strategy-provided, human-readable
  fields: Array<[label, value]>;  // entry/stop/target/size/age…
  chart?: Buffer | null;
}
```

Rendering (`Strategy: H18 / LONG BTCUSDT / Reason: 7-day breakout, 30-day
momentum confirmed`) is one generic formatter. The existing Telegram
machinery (send/edit, buttons, throttles) is reused behind a thin adapter
that maps `NotificationEvent` → the current `Notifier` transport methods.

### What happens to the existing 60s loops

- **outcome-tracker** → becomes the position engine's tick/bar driver.
- **edge monitor** → becomes optional per-strategy logic: SMC strategies
  re-score their thesis inside `updateState`/`evaluateExit`; H18 simply has
  no edge concept. Core-level "edge" disappears (C8 resolved).
- **trade manager** → unchanged short-term (it is advisory); long-term its
  detectors become reusable helpers strategies may call.

### Database

`signal_outcomes` evolves rather than being replaced (Drizzle `db:push`):
- new columns: `strategy_state JSONB`, `max_hold_until`, `qty`, `risk_model`;
  `strategy` becomes a free-form id; `tp` nullable.
- New strategies write positions through `PositionStore`; legacy rows remain
  readable (legacy `StrategyKind` values are valid strategy ids).

## Phases

> **Status (2026-06-12):** Phases 1 ✅, 2 ✅, and 4 ✅ (H18Strategy) are
> implemented; Phase 3 (SMCStrategy) is intentionally deferred — H18 went
> first because it has a validated research reference and exercises the
> trailing-stop machinery. Highlights:
> - Historical data subsystem: `candles` table, `pnpm fetch:history` /
>   `pnpm verify:history`, `MarketDataProvider` (DB + live top-up + cache).
> - `src/strategies/h18.ts` — frozen canonical params; replay-validated
>   against the research reference at 100% parity (565/565 trades, 564
>   exact + 1 tolerated max-hold boundary; `pnpm test:h18:replay`).
> - Telegram adapter throttles stop-move spam; legacy outcome-tracker, edge
>   monitor, and trade manager explicitly skip `source='engine'` rows.
> - Telemetry on GET /health (`engine` key) + `pnpm engine:compare`.
> - Deployment: docs/VPS.md. Engine still **disabled by default**; enabling
>   requires the schema applied (`pnpm db:push` or
>   `scripts/apply-engine-columns.ts` — pending while the Neon transfer
>   quota is exhausted) and a backfilled candle store.

### Phase 1 — Architecture foundation (this change)
Add `src/engine/` (interfaces, position model, exit engine, risk engine,
notification abstraction) with unit-testable pure logic. **No call sites
change.** Files: +7 new, 0 modified. Risk: none (dead code until wired).

### Phase 2 — Strategy engine wiring
- `PositionStore` backed by `signal_outcomes` (schema additions above).
- A `runEngineCycle()` task in `index.ts` that drives registered strategies
  on bar close, alongside the legacy path (both run; engine trades are
  flagged `source='engine'`).
- Notification adapter mapping `NotificationEvent` → existing Telegram.
Files: ~6 new/modified (`db/schema.ts`, `db/accumulate.ts` or new
`db/positions.ts`, `index.ts`, `engine/*`). Risks: schema migration on live
DB (additive only — safe with `db:push`); double-alerting if a symbol is
picked up by both paths (mitigate: engine starts with strategies the legacy
path doesn't have, i.e. H18 only… but H18 implementation is Phase 4, so
Phase 2 ships with a no-op smoke strategy behind a config flag).

### Phase 3 — SMCStrategy: move existing detection into a plug-in
Wrap the four detectors + scoring + gates into one `SMCStrategy` (or four
small ones sharing helpers) implementing `Strategy`. `evaluateEntry` runs
detectors and returns an `EntryIntent` with `reasons` derived from the
existing explainability text; `updateState` carries `{ sweepLevel,
edgeBaseline }`; `evaluateExit` reproduces fixed TP/SL/expiry + edge logic.
The legacy scanner stays live in parallel for comparison (shadow mode:
engine SMC positions are `followed=false`).
Files: ~8 (new `strategies/smc.ts`, edits to scanner-shared helpers).
Risks: behavioral drift vs legacy path — mitigated by running both and
diffing signals for ≥2 weeks; scoring/gates config must produce identical
decisions (snapshot tests on recorded contexts).

### Phase 4 — H18Strategy
Implement H18 as a plug-in using its validated parameters (frozen):
Donchian-7d close-break + 30d momentum filter + skip-ranging;
`state={ highestClose|lowestClose }`, trailing 4·ATR1h via `move_stop`,
14-day max hold, no TP. Reuses the research implementation's exact rule
(`research/validation/h18.ts` is the reference; the live one must produce
identical decisions on the same candles — add a replay test against the
research trades file).
Files: ~3 (`strategies/h18.ts`, registry entry, replay test).
Risks: 15m bar-close cadence must match research semantics (decide at close,
enter via 2h-TTL zone); ATR1h aggregation parity (reuse the research
aggregation code, do not reimplement).

### Phase 5 — Paper trading
Run H18 + SMC through the engine in advisory mode with the risk engine
sizing virtual positions (1% fixed-fraction default). Track engine positions
in the DB exactly like real ones (`followed=true`, qty virtual). Compare:
engine H18 fills vs research expectation (expectancy, fill rate); SMC engine
vs legacy alerts (should be 1:1). Duration: ≥4 weeks (H18 trades ~2-3×/week
across the watchlist). Exit criteria: no missed/duplicate exits, stop
ratchets correct across restarts (state survives via JSONB), notification
quality acceptable.

### Phase 6 — Retire legacy signal path
Flip the scanner task to engine-only, delete `scanner.ts` detector wiring,
`ENTRY_TTL`/`OUTCOME_TTL` records, edge monitor (now inside SMCStrategy),
SMC-specific notify formatters, and `regime/engine.ts`'s `allowedStrategies`.
Keep: analytics (works off the same rows), chart renderer (reads
EntryIntent), trade manager (advisory).
Files: ~10 modified/deleted. Risks: Telegram UX changes (alert layout) —
communicate before flipping; historical analytics continuity (strategy ids
are a superset of old kinds, so queries keep working).

## Estimates

| Phase | New files | Modified | Effort | Risk |
|---|---|---|---|---|
| 1 Foundation | 7 | 0 | S | none (dead code) |
| 2 Wiring | 3 | 4 | M | low (additive schema, flagged) |
| 3 SMCStrategy | 2 | 6 | L | medium (behavior parity) |
| 4 H18Strategy | 2 | 1 | S | low (validated reference exists) |
| 5 Paper trading | 0 | 2 | M (calendar) | low |
| 6 Retire legacy | 0 | ~10 | M | medium (UX + cleanup) |

Implementation order is strictly 1→6; phases 3 and 4 can swap if H18-first
is preferred (smaller, has a validated reference, exercises trailing stops —
the riskiest new machinery — under real conditions sooner).

## Invariants during migration

1. The bot stays read-only on the exchange; risk engine output is advisory.
2. Legacy and engine paths never both alert on the same (symbol, strategy).
3. Every phase ships behind config (`engine.enabled`, `engine.strategies`).
4. `pnpm typecheck` green at every phase; no schema-breaking changes
   (additive columns only until Phase 6).
