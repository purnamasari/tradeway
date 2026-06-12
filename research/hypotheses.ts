// Pre-registered hypotheses. Parameters are FIXED before any backtest run —
// no per-month tuning, no parameter sweeps against the same data they're judged
// on. Each encodes one idea grounded in the blueprint's strategy concepts or a
// lead from the live-trade analysis (2026-06-08 squeeze failure, momentum
// winners expiring before TP).
//
// Acceptance rule (decided in advance):
//   ACCEPT  — filled N >= 30, overall avgR > 0, avgR > 0 in >= 3 of the 4
//             months (counting months with N >= 5), and no regime bucket with
//             N >= 15 strongly negative (avgR < -0.15).
//   REJECT  — fails any of the above with filled N >= 30.
//   INSUFFICIENT — filled N < 30.
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

// ── H0: baselines (drift controls, not edges) ────────────────────────────────
// Enter unconditionally every time the slot frees, ATR-geometry SL/TP. These
// estimate the directional drift any long/short rule must beat.
const baselineLong: Hypothesis = {
  name: "H0a_baseline_long",
  rule: (v) => sig("long", v.close - 0.1 * v.atr15, v.close + 0.1 * v.atr15, v.close - 1.5 * v.atr15, v.close + 2 * v.atr15, 1 * H, 6 * H),
};
const baselineShort: Hypothesis = {
  name: "H0b_baseline_short",
  rule: (v) => sig("short", v.close - 0.1 * v.atr15, v.close + 0.1 * v.atr15, v.close + 1.5 * v.atr15, v.close - 2 * v.atr15, 1 * H, 6 * H),
};

// ── H1: trend pullback ───────────────────────────────────────────────────────
// In a trending regime with an aligned 1h trend, price pulling back to the 15m
// EMA20 resumes the trend. Entry at EMA20 ± 0.15·ATR, SL beyond the last 3-bar
// extreme − 0.5·ATR, TP at 2R.
function emaOf(v: BarView, period: number): number {
  return emaLast(v.c15.map((c) => c.close), period);
}
function emaLast(values: number[], period: number): number {
  const k = 2 / (period + 1);
  const seedLen = Math.min(period, values.length);
  let prev = values.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  for (let i = seedLen; i < values.length; i++) prev = values[i]! * k + prev * (1 - k);
  return prev;
}
const trendPullback: Hypothesis = {
  name: "H1_trend_pullback",
  rule: (v) => {
    if (v.regime.regime !== "trending") return null;
    const e20 = emaOf(v, 20);
    const e50 = emaOf(v, 50);
    const last3 = v.c15.slice(-3);
    const bar = v.c15.at(-1)!;
    if (v.trend.trend === "bullish" && e20 > e50 && bar.low <= e20 && bar.close > e50) {
      const slBase = Math.min(...last3.map((c) => c.low));
      const sl = slBase - 0.5 * v.atr15;
      const entry = e20;
      const risk = entry - sl;
      if (risk <= 0) return null;
      return sig("long", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry + 2 * risk, 1 * H, 6 * H);
    }
    if (v.trend.trend === "bearish" && e20 < e50 && bar.high >= e20 && bar.close < e50) {
      const slBase = Math.max(...last3.map((c) => c.high));
      const sl = slBase + 0.5 * v.atr15;
      const entry = e20;
      const risk = sl - entry;
      if (risk <= 0) return null;
      return sig("short", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry - 2 * risk, 1 * H, 6 * H);
    }
    return null;
  },
};

// ── H2: liquidity sweep reversal ─────────────────────────────────────────────
// In a ranging regime, a bar that pierces the prior 20-bar extreme but CLOSES
// back inside is a stop-hunt; fade it. SL beyond the sweep wick − 0.25·ATR,
// TP at 1.5R.
const liquiditySweep: Hypothesis = {
  name: "H2_liquidity_sweep",
  rule: (v) => {
    if (v.regime.regime !== "ranging") return null;
    const bar = v.c15.at(-1)!;
    const prior = v.c15.slice(-21, -1);
    if (prior.length < 20) return null;
    const lo20 = Math.min(...prior.map((c) => c.low));
    const hi20 = Math.max(...prior.map((c) => c.high));
    if (bar.low < lo20 && bar.close > lo20) {
      const sl = bar.low - 0.25 * v.atr15;
      const entry = bar.close;
      const risk = entry - sl;
      if (risk <= 0) return null;
      return sig("long", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry + 1.5 * risk, 1 * H, 6 * H);
    }
    if (bar.high > hi20 && bar.close < hi20) {
      const sl = bar.high + 0.25 * v.atr15;
      const entry = bar.close;
      const risk = sl - entry;
      if (risk <= 0) return null;
      return sig("short", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry - 1.5 * risk, 1 * H, 6 * H);
    }
    return null;
  },
};

// ── H3: squeeze breakout, trend-aligned vs unaligned ─────────────────────────
// Lead from live trades: squeeze fired 10x on 2026-06-08, 7 SL / 0 TP, mostly
// against the 1h trend. Hypothesis: breakouts from compression are only an edge
// WITH the 1h trend; unaligned ones are noise. Squeeze = ATR pct <= 25 for the
// last 12 bars ending no later than 4 bars ago; trigger = close beyond the
// 12-bar compression range.
function squeezeRule(v: BarView, requireAligned: boolean): HypoSignal | null {
  const n = v.c15.length;
  if (n < 40) return null;
  const bar = v.c15.at(-1)!;
  // Compression window: bars [-16..-5] (12 bars) all had low ATR pct? We only
  // have the latest atrPct, so approximate compression with realized range:
  // the 12-bar range before the last 4 bars is < 2.2 * ATR.
  const compWin = v.c15.slice(-16, -4);
  const compHi = Math.max(...compWin.map((c) => c.high));
  const compLo = Math.min(...compWin.map((c) => c.low));
  if (compHi - compLo > 2.2 * v.atr15) return null;
  // Trigger: this bar closes beyond the compression range.
  if (bar.close > compHi && bar.high - bar.low < 3 * v.atr15) {
    const aligned = v.trend.trend === "bullish";
    if (requireAligned !== aligned) return null;
    const sl = bar.low - 0.5 * v.atr15;
    const entry = bar.close;
    const risk = entry - sl;
    if (risk <= 0) return null;
    return sig("long", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry + 2 * risk, 0.5 * H, 6 * H);
  }
  if (bar.close < compLo && bar.high - bar.low < 3 * v.atr15) {
    const aligned = v.trend.trend === "bearish";
    if (requireAligned !== aligned) return null;
    const sl = bar.high + 0.5 * v.atr15;
    const entry = bar.close;
    const risk = sl - entry;
    if (risk <= 0) return null;
    return sig("short", entry - 0.15 * v.atr15, entry + 0.15 * v.atr15, sl, entry - 2 * risk, 0.5 * H, 6 * H);
  }
  return null;
}
const squeezeAligned: Hypothesis = { name: "H3a_squeeze_aligned", rule: (v) => squeezeRule(v, true) };
const squeezeUnaligned: Hypothesis = { name: "H3b_squeeze_unaligned", rule: (v) => squeezeRule(v, false) };

// ── H4: funding extreme contrarian ───────────────────────────────────────────
// Crowded funding (trailing-30d percentile >= 95 → short; <= 5 → long) mean-
// reverts. ATR geometry: SL 1.5·ATR, TP 2·ATR, 12h horizon.
const fundingExtreme: Hypothesis = {
  name: "H4_funding_extreme",
  rule: (v) => {
    if (v.fundingPct == null) return null;
    if (v.fundingPct >= 95 && v.fundingRate! > 0) {
      return sig("short", v.close - 0.1 * v.atr15, v.close + 0.1 * v.atr15, v.close + 1.5 * v.atr15, v.close - 2 * v.atr15, 1 * H, 12 * H);
    }
    if (v.fundingPct <= 5 && v.fundingRate! < 0) {
      return sig("long", v.close - 0.1 * v.atr15, v.close + 0.1 * v.atr15, v.close - 1.5 * v.atr15, v.close + 2 * v.atr15, 1 * H, 12 * H);
    }
    return null;
  },
};

// ── H5: momentum continuation (two horizons) ─────────────────────────────────
// Lead from live trades: both momentum signals expired in profit before TP.
// Trigger: 4-bar move >= 1.5·ATR in the 1h-trend direction with volume pct >=
// 90 on the last bar. SL 1·ATR behind, TP 2·ATR ahead. Same rule at 4h vs 8h
// outcome horizon — if the 8h variant resolves the live "expired winners"
// problem it should show materially better expectancy with similar N.
function momentumRule(v: BarView, outcomeTtl: number): HypoSignal | null {
  const c = v.c15;
  const bar = c.at(-1)!;
  const move = bar.close - c[c.length - 5]!.close;
  if (v.volPct < 90) return null;
  if (v.trend.trend === "bullish" && move >= 1.5 * v.atr15) {
    return sig("long", bar.close - 0.1 * v.atr15, bar.close + 0.1 * v.atr15, bar.close - 1 * v.atr15, bar.close + 2 * v.atr15, 0.5 * H, outcomeTtl);
  }
  if (v.trend.trend === "bearish" && move <= -1.5 * v.atr15) {
    return sig("short", bar.close - 0.1 * v.atr15, bar.close + 0.1 * v.atr15, bar.close + 1 * v.atr15, bar.close - 2 * v.atr15, 0.5 * H, outcomeTtl);
  }
  return null;
}
const momentum4h: Hypothesis = { name: "H5a_momentum_4h", rule: (v) => momentumRule(v, 4 * H) };
const momentum8h: Hypothesis = { name: "H5b_momentum_8h", rule: (v) => momentumRule(v, 8 * H) };

export const HYPOTHESES: Hypothesis[] = [
  baselineLong,
  baselineShort,
  trendPullback,
  liquiditySweep,
  squeezeAligned,
  squeezeUnaligned,
  fundingExtreme,
  momentum4h,
  momentum8h,
];
