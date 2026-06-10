// Adaptive stop suggestions — replaces "static SL forever" with a regime-aware
// trailing suggestion. Pure: returns a StopSuggestion (or null); the bot never
// moves a stop on the exchange — the trader does.
//
// Method per regime:
//   trending        → swing trailing (last confirmed swing on 15m)
//   high_volatility → ATR trailing (wide chandelier so noise can't run it over)
//   ranging         → structure trailing (nearest S/R level)
//   low_volatility  → EMA trailing (tight, the move should not breathe much)
import type { Candle, Direction, Regime, SRSnapshot, StopMethod, StopSuggestion } from "../types.js";
import type { Rules } from "../config.js";
import { atr, ema } from "../indicators.js";

type ManagementCfg = Rules["management"];

export interface StopInputs {
  direction: Direction;
  entry: number;
  /** Current stop, or null/0 when the position has none set. */
  currentSl: number | null;
  price: number;
  candles15m: Candle[];
  sr: SRSnapshot;
  regime: Regime;
  /** |entry − original SL|; null when unknown (improvement gating falls back to % of price). */
  initialRisk: number | null;
}

const METHOD_BY_REGIME: Record<Regime, StopMethod> = {
  trending: "swing",
  high_volatility: "atr",
  ranging: "structure",
  low_volatility: "ema",
};

/** Most recent fractal swing extreme on the protective side of the trade.
 *  Neighbors must be strictly beyond the candidate — equal lows (double bottom
 *  plateaus) still count as a swing, since the defended level is what matters. */
function lastSwing(candles: Candle[], direction: Direction, lookback = 2): number | null {
  for (let i = candles.length - 1 - lookback; i >= lookback; i--) {
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (direction === "long" && candles[j]!.low < candles[i]!.low) isSwing = false;
      if (direction === "short" && candles[j]!.high > candles[i]!.high) isSwing = false;
      if (!isSwing) break;
    }
    if (isSwing) return direction === "long" ? candles[i]!.low : candles[i]!.high;
  }
  return null;
}

/**
 * Suggest a better protective stop, or null when the current one is already the
 * best available. A suggestion must (a) sit on the protective side of price with
 * at least half an ATR of breathing room, and (b) meaningfully improve on the
 * current stop (>= min_stop_improve_r of the initial risk) — small jitter moves
 * would just spam the trader.
 */
export function suggestStop(i: StopInputs, cfg: ManagementCfg): StopSuggestion | null {
  const sign = i.direction === "long" ? 1 : -1;
  const atr15 = atr(i.candles15m, 14);
  const buffer = i.price * (cfg.stop_buffer_pct / 100);
  const hasStop = i.currentSl != null && i.currentSl > 0;

  // Candidate stops per method (already buffered, on the protective side).
  const candidates: Array<{ method: StopMethod; price: number; reason: string }> = [];

  const swing = lastSwing(i.candles15m, i.direction);
  if (swing != null) {
    candidates.push({
      method: "swing",
      price: swing - sign * buffer,
      reason: `${i.direction === "long" ? "higher low" : "lower high"} formed at ${fmt(swing)}`,
    });
  }

  if (Number.isFinite(atr15) && atr15 > 0) {
    candidates.push({
      method: "atr",
      price: i.price - sign * atr15 * cfg.trail_atr_mult,
      reason: `ATR trail (${cfg.trail_atr_mult}× ATR behind price)`,
    });
  }

  const closes = i.candles15m.map((c) => c.close);
  const emaVal = ema(closes, cfg.trail_ema_period);
  if (Number.isFinite(emaVal)) {
    candidates.push({
      method: "ema",
      price: emaVal - sign * buffer,
      reason: `EMA${cfg.trail_ema_period} trail`,
    });
  }

  const level = i.direction === "long" ? i.sr.support : i.sr.resistance;
  if (level) {
    candidates.push({
      method: "structure",
      price: level.price - sign * buffer,
      reason: `structure ${level.kind} ${fmt(level.price)} (${level.touches} touches)`,
    });
  }

  if (candidates.length === 0) return null;

  // Validity: protective side of price with breathing room; must improve on current.
  const breathing = Number.isFinite(atr15) && atr15 > 0 ? atr15 * 0.5 : i.price * 0.002;
  const minImprove =
    i.initialRisk != null && i.initialRisk > 0
      ? i.initialRisk * cfg.min_stop_improve_r
      : i.price * 0.0015;

  const valid = candidates.filter((c) => {
    const protectiveSide = sign * (i.price - c.price) >= breathing;
    if (!protectiveSide) return false;
    if (!hasStop) return true; // any protective stop beats none
    return sign * (c.price - i.currentSl!) >= minImprove;
  });
  if (valid.length === 0) return null;

  // Prefer the regime's method when it qualifies; otherwise the tightest valid
  // candidate (most risk removed) — a qualifying improvement should not be lost
  // just because the preferred method's level is unavailable.
  const preferred = METHOD_BY_REGIME[i.regime];
  const chosen =
    valid.find((c) => c.method === preferred) ??
    valid.reduce((best, c) => (sign * (c.price - best.price) > 0 ? c : best));

  const reasons = [chosen.reason];
  const beyondEntry = sign * (chosen.price - i.entry) >= 0;
  if (beyondEntry) reasons.push("locks in profit");
  else if (hasStop) reasons.push("reduces risk");
  else reasons.push("position currently has no stop");

  const improvesR =
    hasStop && i.initialRisk != null && i.initialRisk > 0
      ? (sign * (chosen.price - i.currentSl!)) / i.initialRisk
      : 0;

  return {
    price: round(chosen.price),
    method: chosen.method,
    reasons,
    improves_r: Math.round(improvesR * 100) / 100,
  };
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
  return n.toFixed(dp);
}

function round(n: number): number {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
