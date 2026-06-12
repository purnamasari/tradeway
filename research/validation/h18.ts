// H18 as a parameterized strategy for the validation framework. The CANONICAL
// parameters are the ones frozen in research/hypotheses9.ts — the sweep runs
// neighboring values to MEASURE robustness, never to re-tune the strategy.
import type { FastContext } from "./fast-context.js";
import type { Strategy, StratSignal } from "./strategy.js";

const H = 3_600_000;
const DAY_BARS = 96;

export interface H18Params {
  donchianDays: number; // channel lookback (days)
  momentumDays: number; // trend-filter lookback (days)
  momentumThreshold: number; // |r| required, as a fraction (0.05 = 5%)
  stopATR: number; // initial SL distance, ×ATR1h
  trailATR: number; // chandelier trail distance, ×ATR1h
  holdDays: number; // outcome TTL (days)
}

export const H18_CANONICAL: H18Params = {
  donchianDays: 7,
  momentumDays: 30,
  momentumThreshold: 0.05,
  stopATR: 2,
  trailATR: 4,
  holdDays: 14,
};

interface Channel { hi: Float64Array; lo: Float64Array; }

/** Rolling max/min of the PRIOR `bars` bars (exclusive of i), O(n) via
 *  monotonic deques, memoized on the context so sweep variants share it. */
function channel(ctx: FastContext, bars: number): Channel {
  const key = `donchian:${bars}`;
  const hit = ctx.cache.get(key) as Channel | undefined;
  if (hit) return hit;
  const c = ctx.candles;
  const n = c.length;
  const hi = new Float64Array(n).fill(NaN);
  const lo = new Float64Array(n).fill(NaN);
  const dqHi: number[] = [];
  const dqLo: number[] = [];
  for (let i = 0; i < n; i++) {
    // window for index i is [i-bars, i-1]
    if (i >= bars) {
      while (dqHi.length && dqHi[0]! < i - bars) dqHi.shift();
      while (dqLo.length && dqLo[0]! < i - bars) dqLo.shift();
      hi[i] = c[dqHi[0]!]!.high;
      lo[i] = c[dqLo[0]!]!.low;
    }
    while (dqHi.length && c[dqHi[dqHi.length - 1]!]!.high <= c[i]!.high) dqHi.pop();
    dqHi.push(i);
    while (dqLo.length && c[dqLo[dqLo.length - 1]!]!.low >= c[i]!.low) dqLo.pop();
    dqLo.push(i);
  }
  const ch = { hi, lo };
  ctx.cache.set(key, ch);
  return ch;
}

export function h18Strategy(p: H18Params = H18_CANONICAL): Strategy {
  const chBars = Math.round(p.donchianDays * DAY_BARS);
  const moBars = Math.round(p.momentumDays * DAY_BARS);
  return {
    name: "H18",
    params: p as unknown as Record<string, number>,
    minBars: Math.max(chBars + 1, moBars),
    signalAt(ctx: FastContext, i: number): StratSignal | null {
      if (ctx.regime[i] === "ranging" || ctx.regime[i] === "") return null;
      const atr1h = ctx.atr1h[i]!;
      if (!Number.isFinite(atr1h) || atr1h <= 0) return null;
      const close = ctx.closes[i]!;
      const { hi, lo } = channel(ctx, chBars);
      const breakUp = close > hi[i]!;
      const breakDn = close < lo[i]!;
      if (!breakUp && !breakDn) return null;
      const r = close / ctx.closes[i - moBars]! - 1;
      const atr15 = ctx.atr15[i]!;
      const base = {
        entry_low: close - 0.2 * atr15,
        entry_high: close + 0.2 * atr15,
        trail_dist: p.trailATR * atr1h,
        entry_ttl_ms: 2 * H,
        outcome_ttl_ms: p.holdDays * 24 * H,
      };
      if (breakUp && r >= p.momentumThreshold) return { ...base, direction: "long", sl: close - p.stopATR * atr1h };
      if (breakDn && r <= -p.momentumThreshold) return { ...base, direction: "short", sl: close + p.stopATR * atr1h };
      return null;
    },
  };
}
