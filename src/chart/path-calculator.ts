// Expected-path + overlay calculator.
//
// Given an approved Signal and the candle series the chart actually renders,
// produce the overlay the template draws: filled price bands (entry / risk /
// reward / S-R zones), a dotted projection from entry to TP, markers anchored to
// real candle times, and the detected-feature tag chips.
//
// Runs on the *rendered* timeframe (15m), so every marker lands on a visible
// candle. The band/marker/tag model is intentionally generic: new overlay types
// (FVG boxes, order blocks, liquidity zones, BOS markers) slot in as more bands or
// markers without touching the renderer layout.
import type { Candle, PathOverlay, PathBand, Signal } from "../types.js";

// How many candle-widths the dotted projection spans before reaching TP. Only
// affects the slope of the line; fast strategies reach TP sooner.
const PROJECTION_STEPS: Record<Signal["strategy"], number> = {
  liquidity_sweep: 12,
  trend_pullback: 16,
  squeeze: 6,
  momentum: 6,
};

// Direction-aware projection colour.
const LONG_GREEN = "#4ade80";
const SHORT_RED = "#f87171";

// Half-width of an S/R zone as a fraction of the level price.
const SR_ZONE_HALF = 0.003; // ±0.3%

/** Human label for the trigger-candle marker, per strategy. */
const TRIGGER_LABEL: Record<Signal["strategy"], string> = {
  momentum: "Momentum Break",
  squeeze: "Squeeze Break",
  trend_pullback: "Pullback Entry",
  liquidity_sweep: "Entry",
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
 * Common filled bands every signal gets: the entry zone, the red risk band
 * (entry→SL), the green reward band (entry→TP), and S/R zones when present.
 * The renderer draws these behind the candles as semi-transparent fills.
 */
function buildBands(signal: Signal): PathBand[] {
  const entryMid = (signal.entry_low + signal.entry_high) / 2;
  const bands: PathBand[] = [
    { from: entryMid, to: signal.tp, color: "rgba(34, 197, 94, 0.13)", kind: "reward", label: "Reward" },
    { from: entryMid, to: signal.sl, color: "rgba(239, 68, 68, 0.13)", kind: "risk", label: "Risk" },
    { from: signal.entry_low, to: signal.entry_high, color: "rgba(250, 204, 21, 0.20)", kind: "entry", label: "Entry Zone" },
  ];

  const support = signal.snapshot.support?.price;
  if (support != null && Number.isFinite(support)) {
    bands.push({
      from: support * (1 - SR_ZONE_HALF),
      to: support * (1 + SR_ZONE_HALF),
      color: "rgba(56, 189, 248, 0.12)",
      kind: "support",
      label: "Support",
    });
  }
  const resistance = signal.snapshot.resistance?.price;
  if (resistance != null && Number.isFinite(resistance)) {
    bands.push({
      from: resistance * (1 - SR_ZONE_HALF),
      to: resistance * (1 + SR_ZONE_HALF),
      color: "rgba(168, 85, 247, 0.12)",
      kind: "resistance",
      label: "Resistance",
    });
  }
  return bands;
}

/**
 * Detected-feature chips. Only includes what the detectors actually found — no
 * fabricated FVG/BOS tags (those aren't computed yet). Driven by score_breakdown.
 */
function buildTags(signal: Signal): string[] {
  const b = signal.score_breakdown;
  const tags = [signal.direction.toUpperCase(), signal.strategy.replace(/_/g, " ").toUpperCase()];
  if (b.volume_percentile >= 80) tags.push("VOLUME SPIKE");
  if (b.htf_aligned) tags.push("HTF ALIGNED");
  if (b.funding_percentile <= 10 || b.funding_percentile >= 90) tags.push("FUNDING EDGE");
  if (Math.abs(b.oi_zscore) >= 2) tags.push("OI SPIKE");
  if (b.sweep_wick_ratio && b.sweep_wick_ratio > 0) tags.push("SWEEP");
  if (b.structure_intact) tags.push("STRUCTURE");
  return tags;
}

/**
 * Compute the full overlay for a signal against the candle series the chart
 * renders. Bands + tags are common to all strategies; markers + projection are
 * strategy-specific.
 */
export function calculatePath(signal: Signal, candles: Candle[]): PathOverlay {
  const base = (markers: PathOverlay["markers"]): PathOverlay => ({
    markers,
    projectionLine: projectToTarget(
      candles,
      (signal.entry_low + signal.entry_high) / 2,
      signal.tp,
      PROJECTION_STEPS[signal.strategy] ?? 12,
    ),
    projectionColor: signal.direction === "long" ? LONG_GREEN : SHORT_RED,
    zones: [],
    bands: buildBands(signal),
    tags: buildTags(signal),
  });

  if (candles.length === 0) {
    return { markers: [], projectionLine: [], zones: [], bands: [], tags: [] };
  }

  const isLong = signal.direction === "long";
  const entryShape = isLong ? "arrowUp" : "arrowDown";
  const triggerLabel = TRIGGER_LABEL[signal.strategy] ?? "Entry";

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
            text: "Sweep",
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
              text: "Reclaim",
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
          shape: entryShape,
          color: "#facc15",
          text: triggerLabel,
        });
      }
      return base(markers);
    }

    case "trend_pullback": {
      const trigger = candles.at(-1)!;
      return base([
        {
          time: trigger.time,
          position: isLong ? "belowBar" : "aboveBar",
          shape: entryShape,
          color: "#4ade80",
          text: triggerLabel,
        },
      ]);
    }

    case "squeeze":
    case "momentum": {
      const trigger = candles.at(-1)!;
      return base([
        {
          time: trigger.time,
          position: isLong ? "belowBar" : "aboveBar",
          shape: entryShape,
          color: "#c084fc",
          text: triggerLabel,
        },
      ]);
    }

    default:
      return base([]);
  }
}

/** Index of the last element matching `pred`, or -1. (Array.findLastIndex shim.) */
function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}
