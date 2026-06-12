// Round-8 pre-registered hypothesis — BTC-only: dip entry WITHIN a trend.
//
// Trend direction (H14's 30d filter) was real but breakout/channel entries
// paid too much adverse excursion (rounds 5-6); panic reversion alone had no
// signal (round 7). H20 composes the two registered components: enter in the
// 30d-trend direction only on a short-term excursion AGAINST it (classic
// pullback-in-trend, self-calibrating depth):
//
//   long:  r30d >= +5%  AND  r3d at/below trailing-90d 10th pct (r3d < 0)
//   short: r30d <= -5%  AND  r3d at/above trailing-90d 90th pct (r3d > 0)
//   SL 2.5·ATR1h, chandelier trail 3·ATR1h, 5d horizon, 4h entry TTL.
//
// Verdict: standard rule on pooled 41 months AND net avgR > 0 on both
// sub-windows separately.
import type { BarView, Hypothesis, HypoSignal } from "./harness.js";
import { percentileRank } from "../src/indicators.js";

const H = 3_600_000;
const BARS_3D = 3 * 96;
const BARS_30D = 30 * 96;
const BARS_90D = 90 * 96;

function signals(v: BarView): HypoSignal | null {
  if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
  if (v.i < BARS_90D + BARS_3D) return null;
  const c = v.c15full;
  const now = c[v.i]!.close;
  const r30 = now / c[v.i - BARS_30D]!.close - 1;
  const r3d = now / c[v.i - BARS_3D]!.close - 1;
  const hist: number[] = [];
  for (let j = v.i - BARS_90D; j <= v.i; j += 8) hist.push(c[j]!.close / c[j - BARS_3D]!.close - 1);
  const pct = percentileRank(r3d, hist);

  const base = { entry_low: now - 0.2 * v.atr15, entry_high: now + 0.2 * v.atr15, tp: 0, trail_dist: 3 * v.atr1h, entry_ttl_ms: 4 * H, outcome_ttl_ms: 5 * 24 * H };
  if (r30 >= 0.05 && r3d < 0 && pct <= 10) return { ...base, direction: "long", sl: now - 2.5 * v.atr1h };
  if (r30 <= -0.05 && r3d > 0 && pct >= 90) return { ...base, direction: "short", sl: now + 2.5 * v.atr1h };
  return null;
}

export const HYPOTHESES8: Hypothesis[] = [{ name: "H20_trend_dip", rule: signals }];
