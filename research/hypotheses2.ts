// Round-2 pre-registered hypotheses.
//
// Round 1 finding (all 7 rules + 2 baselines REJECTED): at 15m geometry
// (risk ≈ 1–1.5·ATR15 ≈ 0.4–0.7% of price) the taker cost model (0.11% fee +
// 0.04% slippage) costs ~0.2–0.3R per trade, and unconditional baselines are
// ~breakeven gross — the whole loss is the cost hurdle. Round 2 therefore moves
// to LARGER geometry (1h-ATR risk, multi-hour/day horizons) where the same
// costs are ~0.05–0.1R, and conditions on structure that plausibly survives:
// higher-timeframe trend continuation, channel breakouts, and longer-horizon
// funding mean reversion.
//
// Parameters fixed before running. Same acceptance rule as round 1.
import type { BarView, Hypothesis, HypoSignal } from "./harness.js";

const H = 3_600_000;

function sig(
  direction: "long" | "short",
  entryLow: number,
  entryHigh: number,
  sl: number,
  tp: number,
  entryTtl: number,
  outcomeTtl: number,
): HypoSignal {
  return { direction, entry_low: entryLow, entry_high: entryHigh, sl, tp, entry_ttl_ms: entryTtl, outcome_ttl_ms: outcomeTtl };
}

// ── H6: 1h trend pullback ────────────────────────────────────────────────────
// 1h uptrend (ema20 > ema50, close > ema20 on the 1h aggregation) and the 15m
// bar touches the 1h EMA20 from above. Entry at the EMA, SL 2.5·ATR1h, TP 2R,
// 4h to fill, 48h to resolve. Mirror for downtrend.
function emaLast(values: number[], period: number): number {
  const k = 2 / (period + 1);
  const seedLen = Math.min(period, values.length);
  let prev = values.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  for (let i = seedLen; i < values.length; i++) prev = values[i]! * k + prev * (1 - k);
  return prev;
}
const pullback1h: Hypothesis = {
  name: "H6_pullback_1h",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    const closes = v.c1h.map((c) => c.close);
    const e20 = emaLast(closes, 20);
    const e50 = emaLast(closes, 50);
    const bar = v.c15.at(-1)!;
    const spread = Math.abs(e20 - e50) / e50;
    if (spread < 0.002) return null; // EMAs flat → no 1h trend
    if (e20 > e50 && bar.close > e20 * 0.999 && bar.low <= e20 && v.c1h.at(-1)!.close > e50) {
      const entry = e20;
      const sl = entry - 2.5 * v.atr1h;
      return sig("long", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry + 2 * (entry - sl), 4 * H, 48 * H);
    }
    if (e20 < e50 && bar.close < e20 * 1.001 && bar.high >= e20 && v.c1h.at(-1)!.close < e50) {
      const entry = e20;
      const sl = entry + 2.5 * v.atr1h;
      return sig("short", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry - 2 * (sl - entry), 4 * H, 48 * H);
    }
    return null;
  },
};

// ── H7: daily channel breakout (Donchian-style) ──────────────────────────────
// Close breaks the prior 96-bar (24h) extreme → trade the break. SL 2·ATR1h,
// TP 3R, 1h to fill (breakouts move fast), 48h to resolve. The classic
// trend-following entry at a scale where costs are small.
const dailyBreakout: Hypothesis = {
  name: "H7_daily_breakout",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    if (v.c15.length < 98) return null;
    const bar = v.c15.at(-1)!;
    const prior = v.c15.slice(-97, -1);
    const hi = Math.max(...prior.map((c) => c.high));
    const lo = Math.min(...prior.map((c) => c.low));
    if (bar.close > hi) {
      const entry = bar.close;
      const sl = entry - 2 * v.atr1h;
      return sig("long", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry + 3 * (entry - sl), 1 * H, 48 * H);
    }
    if (bar.close < lo) {
      const entry = bar.close;
      const sl = entry + 2 * v.atr1h;
      return sig("short", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry - 3 * (sl - entry), 1 * H, 48 * H);
    }
    return null;
  },
};

// ── H8: volatility expansion follow ──────────────────────────────────────────
// The first bar that lifts ATR percentile to >= 80 after being < 60 four bars
// earlier (fresh expansion, not sustained chop) → follow that bar's direction.
// SL 1.5·ATR1h, TP 2R, 24h to resolve.
const volExpansion: Hypothesis = {
  name: "H8_vol_expansion",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    if (v.atrPct < 80) return null;
    const bar = v.c15.at(-1)!;
    const body = bar.close - bar.open;
    if (Math.abs(body) < 0.5 * v.atr15) return null; // need a directional bar
    // "fresh" check: the bar 4 steps back had a smaller true range than 1·ATR
    const prev = v.c15.at(-5);
    if (!prev || prev.high - prev.low > v.atr15) return null;
    const entry = bar.close;
    if (body > 0) {
      const sl = entry - 1.5 * v.atr1h;
      return sig("long", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry + 2 * (entry - sl), 1 * H, 24 * H);
    }
    const sl = entry + 1.5 * v.atr1h;
    return sig("short", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry - 2 * (sl - entry), 1 * H, 24 * H);
  },
};

// ── H9: funding extreme, deep + slow ─────────────────────────────────────────
// Round-1 H4 (95th pct, 12h) was ~breakeven gross in high-vol. Funding mean
// reversion plays out over days, so: deeper extreme (>= 97 / <= 3), wider
// geometry (SL 2.5·ATR1h), 36h horizon, TP 1.6R.
const fundingDeep: Hypothesis = {
  name: "H9_funding_deep_36h",
  rule: (v) => {
    if (v.fundingPct == null || !Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    const entry = v.close;
    if (v.fundingPct >= 97 && v.fundingRate! > 0) {
      const sl = entry + 2.5 * v.atr1h;
      return sig("short", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry - 1.6 * (sl - entry), 2 * H, 36 * H);
    }
    if (v.fundingPct <= 3 && v.fundingRate! < 0) {
      const sl = entry - 2.5 * v.atr1h;
      return sig("long", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry + 1.6 * (entry - sl), 2 * H, 36 * H);
    }
    return null;
  },
};

// ── H10: multi-day drift continuation ────────────────────────────────────────
// 3-day return defines the drift; enter on a 1-day pullback against it.
// Long when 3d return >= +5% and the last 24h return <= 0 (pullback in an
// uptrend); mirror for shorts. SL 2.5·ATR1h, TP 2R, 48h horizon.
const driftPullback: Hypothesis = {
  name: "H10_drift_pullback",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    const c = v.c15;
    if (c.length < 289) return null;
    const now = c.at(-1)!.close;
    const d1 = c.at(-97)!.close; // 24h ago
    const d3 = c.at(-289)!.close; // 72h ago
    const r3 = (now - d3) / d3;
    const r1 = (now - d1) / d1;
    const entry = now;
    if (r3 >= 0.05 && r1 <= 0) {
      const sl = entry - 2.5 * v.atr1h;
      return sig("long", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry + 2 * (entry - sl), 2 * H, 48 * H);
    }
    if (r3 <= -0.05 && r1 >= 0) {
      const sl = entry + 2.5 * v.atr1h;
      return sig("short", entry - 0.2 * v.atr15, entry + 0.2 * v.atr15, sl, entry - 2 * (sl - entry), 2 * H, 48 * H);
    }
    return null;
  },
};

export const HYPOTHESES2: Hypothesis[] = [pullback1h, dailyBreakout, volExpansion, fundingDeep, driftPullback];
