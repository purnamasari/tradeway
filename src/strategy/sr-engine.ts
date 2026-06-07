// S/R Engine — detect swing pivots, cluster nearby levels, score strength.
// Strength (0-100) combines touch count and recency.
import type { Candle, SRLevel, SRSnapshot } from "../types.js";

const CLUSTER_PCT = 0.003; // 0.3% — merge levels within this band

interface Pivot {
  price: number;
  kind: "support" | "resistance";
}

/** Fractal pivots: a high/low that exceeds `lookback` candles on each side. */
function findPivots(candles: Candle[], lookback = 3): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= c.high) isHigh = false;
      if (candles[j]!.low <= c.low) isLow = false;
    }
    if (isHigh) pivots.push({ price: c.high, kind: "resistance" });
    if (isLow) pivots.push({ price: c.low, kind: "support" });
  }
  return pivots;
}

/** Merge pivots within CLUSTER_PCT into a single level with a touch count. */
function clusterPivots(pivots: Pivot[]): SRLevel[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const levels: SRLevel[] = [];

  for (const p of sorted) {
    const last = levels.at(-1);
    if (last && last.kind === p.kind && Math.abs(p.price - last.price) / last.price <= CLUSTER_PCT) {
      // weighted-average merge, bump touches
      last.price = (last.price * last.touches + p.price) / (last.touches + 1);
      last.touches += 1;
    } else {
      levels.push({ price: p.price, kind: p.kind, touches: 1, strength: 0 });
    }
  }
  return levels;
}

function scoreStrength(levels: SRLevel[]): SRLevel[] {
  const maxTouches = Math.max(1, ...levels.map((l) => l.touches));
  return levels.map((l) => ({
    ...l,
    // touch count dominates; normalize to 0-100.
    strength: Math.round(Math.min(100, (l.touches / maxTouches) * 100)),
  }));
}

/**
 * Build an S/R snapshot from candles, picking the nearest support below and
 * nearest resistance above the current price.
 */
export function buildSR(candles: Candle[], price: number): SRSnapshot {
  const levels = scoreStrength(clusterPivots(findPivots(candles)));

  const supports = levels
    .filter((l) => l.kind === "support" && l.price < price)
    .sort((a, b) => b.price - a.price); // closest below first
  const resistances = levels
    .filter((l) => l.kind === "resistance" && l.price > price)
    .sort((a, b) => a.price - b.price); // closest above first

  return {
    support: supports[0] ?? null,
    resistance: resistances[0] ?? null,
    levels,
  };
}
