// Risk sizing helpers. Centralizes stop-loss placement so every detector sizes
// stops to volatility instead of a flat percentage — a 0.5% stop in a
// high-volatility regime sits inside the noise and gets run over immediately.
import type { Direction } from "./types.js";
import type { Rules } from "./config.js";

/**
 * Widen a structural stop to at least `atr_sl_mult × ATR`, floored/capped by
 * `min_sl_pct`/`max_sl_pct`. Returns the final stop price on the correct side of
 * entry for the trade direction.
 *
 * @param entry        Entry reference price.
 * @param structuralSL The detector's structure-based stop (swing/pullback extreme).
 * @param direction    "long" | "short".
 * @param atr15m       Current ATR on the 15m timeframe (absolute price units).
 * @param cfg          rules.risk
 */
export function widenStopToAtr(
  entry: number,
  structuralSL: number,
  direction: Direction,
  atr15m: number,
  cfg: Rules["risk"],
): number {
  const structuralDist = Math.abs(entry - structuralSL);
  const atrDist = Number.isFinite(atr15m) && atr15m > 0 ? atr15m * cfg.atr_sl_mult : 0;
  const minDist = entry * (cfg.min_sl_pct / 100);
  const maxDist = entry * (cfg.max_sl_pct / 100);

  const dist = Math.min(maxDist, Math.max(structuralDist, atrDist, minDist));
  return direction === "long" ? entry - dist : entry + dist;
}
