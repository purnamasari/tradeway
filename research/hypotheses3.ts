// Round-3 pre-registered hypotheses.
//
// Round 2 long-window result: H6/H10 (the 90d near-misses) collapsed across 15
// months — regime luck. H7 (daily Donchian breakout, fixed 3R TP) was the only
// rule at ~breakeven net with profits concentrated in big-move months — the
// classic trend-following profile whose textbook weakness is a capped right
// tail. Round 3 tests the textbook fix, decided a priori (Turtle-style exits),
// not mined from buckets:
//
//   H11: same 96-bar Donchian close-break entry, but NO take-profit; initial
//        stop 2·ATR1h, chandelier trail 3·ATR1h off the extreme close since
//        entry, 7-day horizon. Edge, if any, must come from the right tail.
//
//   H12: H11 gated to entries whose 15m regime is not "ranging". CAVEAT: this
//        gate was informed by H7's regime breakdown on the SAME Binance window
//        (ranging bucket clearly negative), so H12 is exploratory; it must
//        also hold on the Bybit 90d window to count for anything.
//
// Same acceptance rule as before; verdicts on net taker avgR.
import type { BarView, Hypothesis, HypoSignal } from "./harness.js";

const H = 3_600_000;

function donchianTrail(v: BarView, skipRanging: boolean): HypoSignal | null {
  if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
  if (v.c15.length < 98) return null;
  if (skipRanging && v.regime.regime === "ranging") return null;
  const bar = v.c15.at(-1)!;
  const prior = v.c15.slice(-97, -1);
  const hi = Math.max(...prior.map((c) => c.high));
  const lo = Math.min(...prior.map((c) => c.low));
  const base = {
    entry_ttl_ms: 1 * H,
    outcome_ttl_ms: 7 * 24 * H,
    trail_dist: 3 * v.atr1h,
    tp: 0,
  };
  if (bar.close > hi) {
    const entry = bar.close;
    return { ...base, direction: "long", entry_low: entry - 0.2 * v.atr15, entry_high: entry + 0.2 * v.atr15, sl: entry - 2 * v.atr1h };
  }
  if (bar.close < lo) {
    const entry = bar.close;
    return { ...base, direction: "short", entry_low: entry - 0.2 * v.atr15, entry_high: entry + 0.2 * v.atr15, sl: entry + 2 * v.atr1h };
  }
  return null;
}

export const HYPOTHESES3: Hypothesis[] = [
  { name: "H11_donchian_trail", rule: (v) => donchianTrail(v, false) },
  { name: "H12_donchian_trail_noranging", rule: (v) => donchianTrail(v, true) },
];
