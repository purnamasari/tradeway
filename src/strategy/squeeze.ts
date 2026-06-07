// Squeeze detector.
// Pattern: extreme funding (bottom/top percentile) + OI changes (rising/declining z-score)
// in a high volatility regime.
//
// Short Squeeze (LONG signal): extreme negative funding + rising OI
// Long Squeeze (SHORT signal): extreme positive funding + declining OI
//
// Gating (per Regime × Trend table):
//   regime must allow squeeze (high_volatility)
//   trend bullish -> allows short_squeeze only
//   trend bearish -> allows long_squeeze only
//   trend neutral -> allows both
import type {
  Candle,
  MarketContext,
  RegimeResult,
  Signal,
  SRSnapshot,
  TrendResult,
} from "../types.js";
import type { Rules } from "../config.js";
import { percentileRank, zScore } from "../indicators.js";
import { scoreConfidence, scoreSetupQuality } from "../scoring.js";

export interface DetectResult {
  signal: Signal | null;
  reason: string;
}

export function detectSqueeze(
  ctx: MarketContext,
  regime: RegimeResult,
  trend: TrendResult,
  sr: SRSnapshot,
  rules: Rules,
): DetectResult {
  if (!regime.allowedStrategies.includes("squeeze")) {
    return { signal: null, reason: `regime ${regime.regime} blocks squeeze` };
  }

  // Calculate statistics
  let fundingPct = 50;
  if (ctx.fundingRate !== null && ctx.fundingHistory.length >= 50) {
    fundingPct = percentileRank(ctx.fundingRate, ctx.fundingHistory);
  }

  let oiZ = 0;
  if (ctx.openInterest !== null && ctx.oiHistory.length >= 30) {
    oiZ = zScore(ctx.openInterest, ctx.oiHistory);
  }

  const extremeLow = rules.squeeze?.funding_extreme_low ?? 10;
  const extremeHigh = rules.squeeze?.funding_extreme_high ?? 90;
  const oiMinZ = rules.squeeze?.oi_zscore_min ?? 1.0;
  const oiMaxZ = rules.squeeze?.oi_zscore_max ?? -1.0;

  // Determine potential direction
  let direction: "long" | "short" | null = null;
  let subStrategy: "short_squeeze" | "long_squeeze" | null = null;

  if (fundingPct <= extremeLow && oiZ >= oiMinZ) {
    direction = "long";
    subStrategy = "short_squeeze";
  } else if (fundingPct >= extremeHigh && oiZ <= oiMaxZ) {
    direction = "short";
    subStrategy = "long_squeeze";
  }

  if (!direction || !subStrategy) {
    return {
      signal: null,
      reason: `funding/OI did not reach squeeze criteria (funding pct ${fundingPct.toFixed(1)}, OI z ${oiZ.toFixed(2)})`,
    };
  }

  // Trend gating check
  if (trend.trend === "bullish" && direction === "short") {
    return { signal: null, reason: `long squeeze (short signal) blocked by bullish trend` };
  }
  if (trend.trend === "bearish" && direction === "long") {
    return { signal: null, reason: `short squeeze (long signal) blocked by bearish trend` };
  }

  const c1m = ctx.candles1m;
  const triggerCandle = c1m.at(-1)!;
  const entryRef = triggerCandle.close;

  // Entry band centered around latest price
  const band = entryRef * 0.001;
  const entry_low = entryRef - band;
  const entry_high = entryRef + band;
  const entry = entryRef;

  // SL: set outside the extreme of the last 10 1m candles (capped at 0.5% minimum distance)
  let sl = entryRef;
  const last10 = c1m.slice(-10);
  if (direction === "long") {
    const minLow = Math.min(...last10.map((c) => c.low));
    sl = Math.min(minLow, entryRef * 0.995);
  } else {
    const maxHigh = Math.max(...last10.map((c) => c.high));
    sl = Math.max(maxHigh, entryRef * 1.005);
  }

  // TP: Prefer nearest major S/R level. Fall back to 3:1 RR (3R) target if not present/meaningful.
  const risk = Math.abs(entry - sl);
  let tp = entryRef;
  if (direction === "long") {
    tp = sr.resistance && sr.resistance.price > entryRef
      ? sr.resistance.price
      : entryRef + risk * 3;
  } else {
    tp = sr.support && sr.support.price < entryRef
      ? sr.support.price
      : entryRef - risk * 3;
  }
  const reward = Math.abs(tp - entry);
  const rr = risk === 0 ? 0 : reward / risk;

  // Scoring
  const prevCandle = c1m.at(-2) ?? triggerCandle;
  const { confidence, parts: cParts } = scoreConfidence(
    { ctx, regime, regimeAligned: true },
    rules.confidence_weights,
  );
  const { setup_quality, parts: qParts } = scoreSetupQuality(
    {
      srLevel: null, // Squeeze has no S/R levels
      triggerCandle,
      prevCandle,
      htfAligned: true, // trend-aligned or neutral allows
      candles15m: ctx.candles15m,
    },
    rules.setup_quality_weights,
  );

  const signal: Signal = {
    symbol: ctx.symbol,
    strategy: "squeeze",
    direction,
    entry_low: r(entry_low),
    entry_high: r(entry_high),
    sl: r(sl),
    tp: r(tp),
    rr: round(rr, 2),
    confidence,
    setup_quality,
    score_breakdown: { ...cParts, ...qParts },
    regime: regime.regime,
    trend: trend.trend,
    trend_source: trend.source,
    snapshot: {
      price: entryRef,
      support: sr.support,
      resistance: sr.resistance,
      funding_rate: ctx.fundingRate,
      open_interest: ctx.openInterest,
    },
    detected_at: Date.now(),
  };

  return { signal, reason: `${subStrategy} confirmed (funding pct ${fundingPct.toFixed(1)}, OI z ${oiZ.toFixed(2)})` };
}

function r(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function round(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
