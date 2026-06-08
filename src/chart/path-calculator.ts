// Expected-path overlay calculator.
//
// Given an approved Signal and the candle series the chart actually renders,
// produce per-strategy overlay data: markers anchored to real candle times, a
// dotted projection from entry to TP, and (where useful) a shaded watch zone.
//
// This runs on the *rendered* timeframe (15m), not 1m — so every marker lands on
// a visible candle and the projection extends along the chart's own time axis.
// The blueprint's reference logic is 1m-based; the intent is preserved here while
// the time anchoring is adapted to what the viewer sees.
import type { Candle, PathOverlay, Signal } from "../types.js";

// How many candle-widths the dotted projection spans before reaching TP. Only
// affects the slope of the line; squeezes are fast so they reach TP sooner.
const PROJECTION_STEPS: Record<Signal["strategy"], number> = {
  liquidity_sweep: 12,
  trend_pullback: 16,
  squeeze: 6,
};

/** Seconds between candles in the rendered series (defaults to 15m). */
function candleStep(candles: Candle[]): number {
  if (candles.length >= 2) {
    const step = candles[candles.length - 1]!.time - candles[candles.length - 2]!.time;
    if (step > 0) return step;
  }
  return 15 * 60;
}

/**
 * Build a dotted projection from `entryPrice` to `tpPrice`, starting at the last
 * candle and extending `steps` candle-widths into the future.
 */
function projectToTarget(
  candles: Candle[],
  entryPrice: number,
  tpPrice: number,
  steps: number,
): PathOverlay["projectionLine"] {
  const last = candles.at(-1);
  if (!last || steps <= 0) return [];
  const step = candleStep(candles);
  return Array.from({ length: steps + 1 }, (_, i) => ({
    time: last.time + i * step,
    value: entryPrice + (tpPrice - entryPrice) * (i / steps),
  }));
}

/**
 * Compute the expected-path overlay for a signal against the candle series the
 * chart renders. Returns empty arrays for unknown strategies — the chart simply
 * draws nothing extra.
 */
export function calculatePath(signal: Signal, candles: Candle[]): PathOverlay {
  const empty: PathOverlay = { markers: [], projectionLine: [], zones: [] };
  if (candles.length === 0) return empty;

  const entryPrice = (signal.entry_low + signal.entry_high) / 2;
  const steps = PROJECTION_STEPS[signal.strategy] ?? 12;
  const isLong = signal.direction === "long";

  switch (signal.strategy) {
    case "liquidity_sweep": {
      const level = isLong ? signal.snapshot.support?.price : signal.snapshot.resistance?.price;
      const markers: PathOverlay["markers"] = [];

      if (level != null && isFinite(level)) {
        // Most recent candle whose wick pierced the level.
        const sweepIdx = findLastIndex(candles, (c) =>
          isLong ? c.low < level * 0.995 : c.high > level * 1.005,
        );
        if (sweepIdx >= 0) {
          markers.push({
            time: candles[sweepIdx]!.time,
            position: isLong ? "belowBar" : "aboveBar",
            shape: isLong ? "arrowDown" : "arrowUp",
            color: "#f87171",
            text: "sweep",
          });
          // First candle after the sweep that closed back across the level.
          const reclaim = candles
            .slice(sweepIdx + 1)
            .find((c) => (isLong ? c.close > level : c.close < level));
          if (reclaim) {
            markers.push({
              time: reclaim.time,
              position: isLong ? "aboveBar" : "belowBar",
              shape: "circle",
              color: "#facc15",
              text: "reclaim",
            });
          }
        }
      }

      // The sweep wick often lives in 1m action no 15m candle captured. Always
      // anchor at least an entry marker on the last candle so the chart is never
      // marker-less and the reader can see where the entry sits.
      if (markers.length === 0) {
        markers.push({
          time: candles.at(-1)!.time,
          position: isLong ? "belowBar" : "aboveBar",
          shape: isLong ? "arrowUp" : "arrowDown",
          color: "#facc15",
          text: "entry",
        });
      }

      return {
        markers,
        projectionLine: projectToTarget(candles, entryPrice, signal.tp, steps),
        zones: [], // entry band is already drawn by the template
      };
    }

    case "trend_pullback": {
      const level = isLong ? signal.snapshot.support?.price : signal.snapshot.resistance?.price;
      const trigger = candles.at(-1)!;

      const zones: PathOverlay["zones"] =
        level != null && isFinite(level)
          ? [
              {
                from: level * 0.995,
                to: level * 1.005,
                color: isLong ? "rgba(74, 222, 128, 0.08)" : "rgba(248, 113, 113, 0.08)",
                label: isLong ? "Support" : "Resistance",
              },
            ]
          : [];

      return {
        markers: [
          {
            time: trigger.time,
            position: isLong ? "aboveBar" : "belowBar",
            shape: isLong ? "arrowUp" : "arrowDown",
            color: "#4ade80",
            text: "entry",
          },
        ],
        projectionLine: projectToTarget(candles, entryPrice, signal.tp, steps),
        zones,
      };
    }

    case "squeeze": {
      const trigger = candles.at(-1)!;
      return {
        markers: [
          {
            time: trigger.time,
            position: isLong ? "belowBar" : "aboveBar",
            shape: isLong ? "arrowUp" : "arrowDown",
            color: "#c084fc",
            text: "squeeze",
          },
        ],
        projectionLine: projectToTarget(candles, entryPrice, signal.tp, steps),
        zones: [],
      };
    }

    default:
      return empty;
  }
}

/** Index of the last element matching `pred`, or -1. (Array.findLastIndex shim.) */
function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}
