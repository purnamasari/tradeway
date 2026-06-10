// Expected-path probabilities — a calibrated-looking heuristic, not a model.
// Splits the outcome space into three paths:
//   A  tp_direct       price runs to TP without revisiting entry
//   B  retest_then_tp  price retests entry/support first, then reaches TP
//   C  sl_hit          stop is hit
// Used twice: at signal time (strength = combined confidence/setup score) and
// live (strength = blend of health and current confidence), so the user can watch
// the split shift as the trade evolves. Integers, always summing to 100.
import type { Direction, PathProbabilities } from "../types.js";

export interface PathInputs {
  direction: Direction;
  price: number;
  entry: number;
  sl: number;
  tp: number;
  /** 0-1 — how strong the case for the trade is right now. */
  strength: number;
  /** Momentum strategy entries resolve directly more often. */
  strategy?: string;
  /** Current volume percentile (0-100), if known. */
  volumePercentile?: number;
  /** Live momentum component (0-100), if known — shifts direct vs retest. */
  momentumScore?: number;
}

export function estimatePaths(i: PathInputs): PathProbabilities | null {
  // 0 is the "not set" sentinel for SL/TP throughout (Bybit positions) — no
  // levels means no defined paths.
  if (i.sl <= 0 || i.tp <= 0) return null;
  const risk = Math.abs(i.entry - i.sl);
  const reward = Math.abs(i.tp - i.entry);
  if (risk <= 0 || reward <= 0) return null;
  const rr = reward / risk;
  const sign = i.direction === "long" ? 1 : -1;

  // C — stop probability: anchored on strength, then discounted by progress
  // already made toward TP (a trade at +1R fails less often than one at entry).
  let pSl = clampN(45 - 40 * clamp01(i.strength), 5, 60);
  const progressR = (sign * (i.price - i.entry)) / risk;
  if (progressR > 0) pSl *= clampN(1 - progressR * 0.3, 0.4, 1);
  if (progressR < -0.5) pSl *= 1.25; // already underwater past half the risk
  pSl = clampN(pSl, 4, 70);

  // A vs B — split the remainder. Momentum entries and high participation favor
  // a direct run; a far TP (high RR) favors at least one retest on the way.
  let directFrac = i.strategy === "momentum" ? 0.42 : 0.34;
  if ((i.volumePercentile ?? 0) >= 90) directFrac += 0.05;
  if (i.momentumScore != null) directFrac += (i.momentumScore - 50) / 500; // ±0.1
  directFrac -= Math.max(0, rr - 2) * 0.06;
  directFrac = clampN(directFrac, 0.15, 0.6);

  const remaining = 100 - pSl;
  const a = Math.round(remaining * directFrac);
  const c = Math.round(pSl);
  const b = 100 - a - c;
  return { tp_direct: a, retest_then_tp: b, sl_hit: c };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function clampN(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
