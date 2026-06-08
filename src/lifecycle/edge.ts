// Edge lifecycle — pure(ish) recompute of a signal's edge from current market data.
//
// `computeEdgeSnapshot` re-runs the same regime/trend/scoring used at detection so
// live values are directly comparable to the immutable originals. `classifyEdgeState`
// turns the comparison into ACTIVE / EDGE_WEAKENING / INVALIDATED — conservatively:
// a single failed condition is only EDGE_WEAKENING; INVALIDATED needs multiple soft
// failures or one critical condition (confidence collapse).
import type { Cache } from "../cache.js";
import type { Env, Rules } from "../config.js";
import type {
  MarketContext,
  StrategyKind,
  Direction,
  EdgeSnapshot,
  EdgeState,
  Trend,
} from "../types.js";
import { classifyRegime } from "../regime/engine.js";
import { classifyTrend } from "../ai/trend-classifier.js";
import { buildSR } from "../strategy/sr-engine.js";
import { scoreConfidence, scoreSetupQuality } from "../scoring.js";
import { ema } from "../indicators.js";

const HTF_TOLERANCE = 0.005; // 4H EMA within 0.5% of the level => aligned (mirrors detectors)

function trendAligns(direction: Direction, trend: Trend): boolean {
  return direction === "long" ? trend === "bullish" : trend === "bearish";
}

/**
 * Recompute a signal's edge from the current context. Mirrors the scoring done by
 * the detectors at detection time so live vs original is apples-to-apples.
 * `ctx` must already be history-hydrated (see hydrateContextHistory).
 */
export async function computeEdgeSnapshot(
  ctx: MarketContext,
  strategy: StrategyKind,
  direction: Direction,
  rules: Rules,
  cache: Cache,
  env: Env,
): Promise<EdgeSnapshot> {
  const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);
  const regimeAligned = regime.allowedStrategies.includes(strategy);

  const closes4h = ctx.candles4h.map((c) => c.close);
  const ema20 = ema(closes4h, rules.regime.ema_fast);
  const ema50 = ema(closes4h, rules.regime.ema_slow);
  const trend = await classifyTrend(ctx.symbol, ctx.candles4h, ema20, ema50, {
    cache,
    rules: rules.trend,
    geminiApiKey: env.geminiApiKey,
  });

  const { confidence, parts: cParts } = scoreConfidence(
    { ctx, regime, regimeAligned },
    rules.confidence_weights,
  );

  // Live structure read: use the current S/R level for the trade direction plus the
  // last 15m candle as the trigger. Sweep wick ratio is detection-time-only, so it
  // is omitted here — structure_intact + S/R strength carry the live structural signal.
  const price = ctx.candles15m.at(-1)?.close ?? 0;
  const sr = buildSR(ctx.candles15m, price);
  const level = direction === "long" ? sr.support : sr.resistance;
  const htfAligned =
    level != null && Number.isFinite(ema20)
      ? Math.abs(ema20 - level.price) / level.price <= HTF_TOLERANCE
      : false;
  const triggerCandle = ctx.candles15m.at(-1)!;
  const prevCandle = ctx.candles15m.at(-2) ?? triggerCandle;

  const { setup_quality, parts: qParts } = scoreSetupQuality(
    { srLevel: level, triggerCandle, prevCandle, htfAligned, candles15m: ctx.candles15m },
    rules.setup_quality_weights,
  );

  return {
    confidence,
    setup_quality,
    funding_percentile: cParts.funding_percentile,
    oi_zscore: cParts.oi_zscore,
    volume_percentile: cParts.volume_percentile,
    structure_intact: qParts.structure_intact,
    trend: trend.trend,
    trend_aligned: trendAligns(direction, trend.trend),
    regime_aligned: regimeAligned,
  };
}

export interface EdgeOriginal {
  confidence: number;
  funding_percentile: number;
  oi_zscore: number;
  trend: Trend; // trend at signal creation
  structure_intact: boolean; // structure quality at signal creation
  direction: Direction;
}

/**
 * Classify edge health from original vs live. Strictly **regression-based**: a
 * condition is only a failure if it HELD at signal creation and has since failed —
 * never an absolute check. (A squeeze may be emitted counter-trend, a setup may
 * start with imperfect structure; neither is deterioration. A trend drifting to
 * *neutral* is not a reversal.) Conservative: one soft failure is EDGE_WEAKENING;
 * INVALIDATED requires `invalidate_min_failures` soft failures OR a critical
 * condition (live confidence at/below the floor).
 */
export function classifyEdgeState(
  original: EdgeOriginal,
  live: EdgeSnapshot,
  t: Rules["lifecycle"],
): { state: EdgeState; reasons: string[] } {
  const soft: string[] = [];

  // Regime was permitted at the gate, so losing it is always a true regression.
  if (!live.regime_aligned) soft.push("Regime no longer supports strategy");

  // Trend: only a failure if it was aligned at creation AND has since reversed to
  // the opposite side. Drifting to neutral does not count (that is mild, and shows
  // up via confidence, not as an invalidating reversal).
  const origTrendAligned = trendAligns(original.direction, original.trend);
  const trendReversed = original.direction === "long" ? live.trend === "bearish" : live.trend === "bullish";
  if (origTrendAligned && trendReversed) soft.push("Trend reversed");

  // Structure: only a failure if it was intact at creation and has since broken.
  if (original.structure_intact && !live.structure_intact) soft.push("Structure broken");

  const drop = original.confidence - live.confidence;
  if (drop >= t.weakening_confidence_drop) {
    soft.push(`Confidence ${original.confidence}→${live.confidence}`);
  }

  // Funding extremity normalizing toward the median.
  const origFundingExtremity = Math.abs(original.funding_percentile - 50);
  const liveFundingExtremity = Math.abs(live.funding_percentile - 50);
  if (origFundingExtremity >= 40 && liveFundingExtremity <= 20) {
    soft.push("Funding normalized");
  }

  // OI z-score reverting toward the mean.
  if (Math.abs(original.oi_zscore) >= 2 && Math.abs(live.oi_zscore) <= 1) {
    soft.push("OI z-score reverted");
  }

  const critical = live.confidence <= t.invalidate_confidence_floor;
  const reasons = [...soft];

  let state: EdgeState;
  if (critical) {
    state = "INVALIDATED";
    if (!reasons.some((r) => r.startsWith("Confidence"))) {
      reasons.unshift(`Confidence collapsed to ${live.confidence}`);
    }
  } else if (soft.length >= t.invalidate_min_failures) {
    state = "INVALIDATED";
  } else if (soft.length >= 1) {
    state = "EDGE_WEAKENING";
  } else {
    state = "ACTIVE";
  }

  return { state, reasons };
}
