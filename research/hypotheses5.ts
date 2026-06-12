// Round-5 pre-registered hypotheses — BTC-only, multi-day scale.
//
// Rationale: rounds 1-4 established that (a) gross expectancy at 15m/1h
// horizons is ~zero on BTC, and (b) the cost hurdle shrinks to ~0.05R at
// multi-day geometry. The two strongest literature-backed families at that
// scale are time-series momentum (Moskowitz/Ooi/Pedersen; ~1-month lookback
// is the standard crypto TSMOM finding) and weekly-channel breakouts (Turtle
// System 2). Parameters below come from those references, fixed before
// running — not from any bucket of ours:
//
//   H14 TSMOM:    once per day at 00:00 UTC, 30d return >= +5% → long,
//                 <= -5% → short. SL 3·ATR1h, chandelier trail 4·ATR1h,
//                 5d horizon, 2h entry TTL.
//   H15 Turtle:   close breaks the prior 7d (672-bar) extreme → trade the
//                 break. SL 2·ATR1h... per Turtle S2: stop 2·N, trail on the
//                 opposite 3.5d (336-bar) channel. We use SL 2·ATR1h and
//                 chandelier trail 4·ATR1h (our sim supports distance trails),
//                 14d horizon, 2h entry TTL.
//
// Same acceptance rule as before, judged on the pooled 41-month BTC window.
import type { Hypothesis, HypoSignal } from "./harness.js";

const H = 3_600_000;
const DAY_BARS = 96;

const tsmom: Hypothesis = {
  name: "H14_tsmom_30d",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    if (v.closeTime % 86_400 !== 0) return null; // decide once per day, 00:00 UTC close
    if (v.i < 30 * DAY_BARS) return null;
    const now = v.c15full[v.i]!.close;
    const past = v.c15full[v.i - 30 * DAY_BARS]!.close;
    const r30 = (now - past) / past;
    const base = { entry_low: now - 0.2 * v.atr15, entry_high: now + 0.2 * v.atr15, tp: 0, trail_dist: 4 * v.atr1h, entry_ttl_ms: 2 * H, outcome_ttl_ms: 5 * 24 * H };
    if (r30 >= 0.05) return { ...base, direction: "long", sl: now - 3 * v.atr1h } as HypoSignal;
    if (r30 <= -0.05) return { ...base, direction: "short", sl: now + 3 * v.atr1h } as HypoSignal;
    return null;
  },
};

const turtle: Hypothesis = {
  name: "H15_turtle_7d",
  rule: (v) => {
    if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
    const N = 7 * DAY_BARS;
    if (v.i < N + 1) return null;
    const bar = v.c15full[v.i]!;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = v.i - N; j < v.i; j++) {
      const c = v.c15full[j]!;
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    const base = { entry_low: bar.close - 0.2 * v.atr15, entry_high: bar.close + 0.2 * v.atr15, tp: 0, trail_dist: 4 * v.atr1h, entry_ttl_ms: 2 * H, outcome_ttl_ms: 14 * 24 * H };
    if (bar.close > hi) return { ...base, direction: "long", sl: bar.close - 2 * v.atr1h } as HypoSignal;
    if (bar.close < lo) return { ...base, direction: "short", sl: bar.close + 2 * v.atr1h } as HypoSignal;
    return null;
  },
};

export const HYPOTHESES5: Hypothesis[] = [tsmom, turtle];
