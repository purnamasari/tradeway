// Round-7 pre-registered hypotheses — BTC-only, multi-day mean reversion.
//
// Round 5/6 closed the trend-following family on BTC: positive 2023-24,
// negative 2025-26 (non-stationary). The complementary documented family is
// overreaction reversal: after an unusually large multi-day drawdown, forward
// returns are positive. Trigger is self-calibrating (percentile of the
// instrument's own trailing distribution) so no magnitude threshold is tuned:
//
//   H19a long-dip:  3d return at or below the trailing-90d 5th percentile
//                   (and negative) → long at close. SL 2.5·ATR1h,
//                   TP 2.5·ATR1h (1:1), 3d horizon, 2h entry TTL.
//   H19b short-rip: mirror at the 95th percentile (and positive) → short.
//                   Registered separately — crypto rallies are expected to
//                   persist more than panics, so this likely fails; testing
//                   it documents the asymmetry instead of assuming it.
//
// Verdict: standard rule on pooled 41 months AND net avgR > 0 on both
// sub-windows (2023-01..2025-02, 2025-03..2026-05) separately.
import type { BarView, Hypothesis, HypoSignal } from "./harness.js";
import { percentileRank } from "../src/indicators.js";

const H = 3_600_000;
const BARS_3D = 3 * 96;
const BARS_90D = 90 * 96;
const SAMPLE_STEP = 8; // r3d sampled every 2h over the trailing 90d

function r3dPercentile(v: BarView): { r3d: number; pct: number } | null {
  if (v.i < BARS_90D + BARS_3D) return null;
  const c = v.c15full;
  const r3d = c[v.i]!.close / c[v.i - BARS_3D]!.close - 1;
  const hist: number[] = [];
  for (let j = v.i - BARS_90D; j <= v.i; j += SAMPLE_STEP) {
    hist.push(c[j]!.close / c[j - BARS_3D]!.close - 1);
  }
  return { r3d, pct: percentileRank(r3d, hist) };
}

function mk(v: BarView, direction: "long" | "short"): HypoSignal {
  const e = v.close;
  const d = 2.5 * v.atr1h;
  return direction === "long"
    ? { direction, entry_low: e - 0.2 * v.atr15, entry_high: e + 0.2 * v.atr15, sl: e - d, tp: e + d, entry_ttl_ms: 2 * H, outcome_ttl_ms: 3 * 24 * H }
    : { direction, entry_low: e - 0.2 * v.atr15, entry_high: e + 0.2 * v.atr15, sl: e + d, tp: e - d, entry_ttl_ms: 2 * H, outcome_ttl_ms: 3 * 24 * H };
}

export const HYPOTHESES7: Hypothesis[] = [
  {
    name: "H19a_panic_dip_long",
    rule: (v) => {
      if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
      const r = r3dPercentile(v);
      if (!r || r.r3d >= 0 || r.pct > 5) return null;
      return mk(v, "long");
    },
  },
  {
    name: "H19b_rip_short",
    rule: (v) => {
      if (!Number.isFinite(v.atr1h) || v.atr1h <= 0) return null;
      const r = r3dPercentile(v);
      if (!r || r.r3d <= 0 || r.pct < 95) return null;
      return mk(v, "short");
    },
  },
];
