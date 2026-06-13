# Implementation Spec: Weekly (1w) and Monthly (1M) Timeframe Support

## Overview

This change adds two higher timeframes to the bot's type system and Bybit client, extends candle backfill to cover weekly bars, and introduces a **multi-tier S/R engine** (`buildSRMultiTier`) that fuses scalp-level (1h) and structural-level (weekly) support/resistance into a single tagged snapshot.

Monthly (`1M`) is added only as a queryable/typed timeframe (live fetch via the Bybit `INTERVAL` map). It is **deliberately excluded** from `HISTORY_TIMEFRAMES` and from `TIMEFRAME_SEC`-based gap/verification math, because monthly bars do not have a fixed second-length (28-31 days), which would break the fixed-stride gap detection in `src/data/history/backfill.ts` and `repo.ts`. Weekly bars are a fixed 604,800 s and are safe for that machinery.

---

## 1. `src/types.ts`

### 1.1 Extend the `Timeframe` union (line 14)

**Before:**
```ts
export type Timeframe = "1m" | "15m" | "1h" | "4h" | "1d";
```

**After:**
```ts
export type Timeframe = "1m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
```

### 1.2 Extend `TIMEFRAME_SEC` (lines 17-23)

```ts
export const TIMEFRAME_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800,
  // NOTE: nominal 30d. Calendar months are 28-31d, so this value is approximate.
  // It must NOT be used for "1M" gap detection or bar-count verification.
  "1M": 2_592_000,
};
```

### 1.3 Add tier tagging to S/R types (after SRSnapshot, ~line 61)

```ts
export type SRTier = "scalp" | "structural";

export interface TieredSRLevel extends SRLevel {
  tier: SRTier;
}

export interface SRTierSnapshot {
  scalp: SRSnapshot;
  structural: SRSnapshot;
  combined: TieredSRLevel[];
}
```

---

## 2. `src/data/bybit.ts`

### 2.1 Extend the `INTERVAL` map (lines 8-14)

```ts
const INTERVAL: Record<Timeframe, string> = {
  "1m": "1",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
  "1M": "M",
};
```

---

## 3. `src/data/history/backfill.ts`

### 3.1 Extend `HISTORY_TIMEFRAMES` (line 12)

```ts
export const HISTORY_TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];
```

Do NOT add "1M" — monthly bars lack a fixed second-stride.

---

## 4. `src/strategy/sr-engine.ts`

### 4.1 Imports

Add `SRTier`, `SRTierSnapshot`, `TieredSRLevel` to the import from `../types.js`.

### 4.2 Add module config (after CLUSTER_PCT)

```ts
export interface SREngineConfig {
  weeklyLookback: number;
}

export const config: SREngineConfig = {
  weeklyLookback: 2,
};

export function configureSR(partial: Partial<SREngineConfig>): void {
  Object.assign(config, partial);
}
```

### 4.3 Refactor buildSR into reusable helpers

```ts
function buildLevels(candles: Candle[], lookback: number): SRLevel[] {
  return scoreStrength(clusterPivots(findPivots(candles, lookback)));
}

function nearest(levels: SRLevel[], price: number): SRSnapshot {
  const supports = levels
    .filter((l) => l.kind === "support" && l.price < price)
    .sort((a, b) => b.price - a.price);
  const resistances = levels
    .filter((l) => l.kind === "resistance" && l.price > price)
    .sort((a, b) => a.price - b.price);
  return {
    support: supports[0] ?? null,
    resistance: resistances[0] ?? null,
    levels,
  };
}

export function buildSR(candles: Candle[], price: number): SRSnapshot {
  return nearest(buildLevels(candles, 3), price);
}
```

### 4.4 Add buildSRMultiTier

```ts
export function buildSRMultiTier(
  candles: Candle[],
  weeklyCandles: Candle[],
  price: number,
): SRTierSnapshot {
  const scalpLevels = buildLevels(candles, 3);
  const structuralLevels = buildLevels(weeklyCandles, config.weeklyLookback);

  const scalp = nearest(scalpLevels, price);
  const structural = nearest(structuralLevels, price);

  const tag = (levels: SRLevel[], tier: SRTier): TieredSRLevel[] =>
    levels.map((l) => ({ ...l, tier }));

  const combined: TieredSRLevel[] = [
    ...tag(scalpLevels, "scalp"),
    ...tag(structuralLevels, "structural"),
  ];

  return { scalp, structural, combined };
}
```

---

## 5. `src/config.ts`

### 5.1 Extend Rules.backfill interface

Add `sr` sub-block:
```ts
  backfill: {
    // ...existing fields...
    sr: {
      weekly_lookback: number;
    };
  };
```

### 5.2 Add default and merge in loadRules

```ts
const BACKFILL_SR_DEFAULTS: Rules["backfill"]["sr"] = {
  weekly_lookback: 2,
};

// In loadRules(), before return:
rules.backfill.sr = { ...BACKFILL_SR_DEFAULTS, ...(rules.backfill?.sr ?? {}) };
```

### 5.3 Add YAML entry

In `config/rules.yaml`, under `backfill:`:
```yaml
  sr:
    weekly_lookback: 2
```

---

## 6. Integration Point

### 6.1 Apply config at startup

Wherever `loadRules()` is consumed during bootstrap (likely `src/index.ts` or the scan-loop setup):
```ts
import { configureSR } from "./strategy/sr-engine.js";
configureSR({ weeklyLookback: rules.backfill.sr.weekly_lookback });
```

### 6.2 Extend MarketContext

Add optional `candles1w` to `MarketContext` in `src/types.ts`:
```ts
export interface MarketContext {
  // ...existing fields...
  candles1w?: Candle[]; // weekly HTF for structural S/R (optional until backfilled)
}
```

### 6.3 Source weekly candles in the context provider

The `HybridMarketDataProvider` and `DbMarketDataProvider` already read from the `candles` table by timeframe. Once `1w` is in `HISTORY_TIMEFRAMES` and backfilled, weekly candles will be in the DB.

The context is assembled in `src/scanner.ts` via `deps.getContext()`. The context provider needs to also fetch `candles1w` from the DB. Find where `candles1m/15m/1h` are populated and add:
```ts
candles1w: db ? await fetchLastCandles(db, symbol, "1w", 100) : [],
```

### 6.4 Wire buildSRMultiTier in the scanner

In `src/scanner.ts`, the current call is:
```ts
const sr = buildSR(ctx.candles15m, price);
```

Replace with:
```ts
const sr = buildSRMultiTier(ctx.candles15m, ctx.candles1w ?? [], price);
```

Note: `buildSRMultiTier` uses 15m candles for scalp (matching current behavior) and weekly for structural. The `scalp` field of the returned snapshot is behavior-identical to the old `buildSR(ctx.candles15m, price)`.

### 6.5 Update sr type in buildBriefing

The `buildBriefing` function in `scanner.ts` currently expects `ReturnType<typeof buildSR>` (an `SRSnapshot`). Update it to accept `SRTierSnapshot` and use `sr.scalp` for the existing display logic. The structural levels can be added as an extra section in the briefing.

### 6.6 Existing consumers

Other callers of `buildSR` (`management/assess.ts`, `backtest/engine.ts`, `lifecycle/edge.ts`, `test-chart.ts`, `data/mock.ts`) continue working unchanged — they still import and call the original `buildSR`. Only the main scanner pipeline uses `buildSRMultiTier`.

---

## 7. Verification Steps

1. `npm run typecheck` — green build confirms exhaustive Record types are complete
2. Unit test `buildSRMultiTier`: synthetic candles, assert scalp matches buildSR parity, combined length, tier tagging, empty weeklyCandles edge case, config override
3. Config default test: load rules.yaml without `backfill.sr` → default 2; with override → overridden
4. Bybit smoke: `fetchCandles("BTCUSDT", "1w", "linear", 10)` → 10 weekly candles, ~604800s spacing, Monday-aligned
5. Backfill verification: run backfill for one symbol, verifySeries for "1w" → misaligned=0, gaps empty
6. Runtime smoke: start scan loop, confirm configureSR ran, structural tier populates
