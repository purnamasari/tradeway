// Leverage advisory — a strategy-agnostic helper that turns an entry/stop pair
// into a stop-safe leverage ceiling for the notification. It models nothing
// strategy-specific: it only answers "how much leverage keeps liquidation
// safely BEYOND my stop?".
//
// Reasoning: on isolated margin at leverage L, an adverse move of ~1/L wipes
// the margin (liquidation), ignoring maintenance margin and fees. To make sure
// the STOP triggers well before liquidation, we require the stop distance times
// a safety buffer to stay inside that 1/L band:
//
//     stopDistFrac · buffer  <  1 / L     ⇒     L  <  1 / (stopDistFrac · buffer)
//
// The result is a CEILING, not a recommendation to use it. Risk per trade is
// governed by POSITION SIZE (the risk engine), not by leverage — leverage only
// decides how much margin the same notional ties up and where liquidation sits.
export interface LeverageRec {
  /** |entry − stop| / entry, as a percent. */
  stopDistPct: number;
  /** Largest integer leverage that keeps liquidation beyond the stop (with the
   *  safety buffer), clamped to [1, cap]. */
  maxLeverage: number;
}

export function recommendLeverage(
  entry: number,
  stop: number,
  opts: { buffer?: number; cap?: number } = {},
): LeverageRec | null {
  const buffer = opts.buffer ?? 3;
  const cap = opts.cap ?? 25;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0) return null;
  const stopDistFrac = Math.abs(entry - stop) / entry;
  if (!(stopDistFrac > 0)) return null;
  const raw = 1 / (stopDistFrac * buffer);
  const maxLeverage = Math.max(1, Math.min(cap, Math.floor(raw)));
  return { stopDistPct: stopDistFrac * 100, maxLeverage };
}
