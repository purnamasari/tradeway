// Liquidity Sweep detector.
// Pattern: price wicks through an S/R level (grabbing liquidity) then closes
// back inside (reclaim). Long off a swept support, short off a swept resistance.
//
// Gating (per the Regime x Trend table):
//   regime must allow liquidity_sweep (ranging)
//   trend gates direction: bullish -> long only, bearish -> short only, neutral -> block
import type {
  Candle,
  MarketContext,
  RegimeResult,
  Signal,
  SRSnapshot,
  TrendResult,
} from "../types.js";
import type { Rules } from "../config.js";
import { ema, atr } from "../indicators.js";
import { scoreConfidence, scoreSetupQuality } from "../scoring.js";
import { widenStopToAtr } from "../risk.js";

const SWEEP_PENETRATION = 0.001; // 0.1% beyond the level counts as a sweep
const HTF_TOLERANCE = 0.005; // 4H level within 0.5% of 15m level => aligned

export interface DetectResult {
  signal: Signal | null;
  reason: string;
}

export function detectLiquiditySweep(
  ctx: MarketContext,
  regime: RegimeResult,
  trend: TrendResult,
  sr: SRSnapshot,
  rules: Rules,
): DetectResult {
  if (!regime.allowedStrategies.includes("liquidity_sweep")) {
    return { signal: null, reason: `regime ${regime.regime} blocks liquidity_sweep` };
  }
  if (trend.trend === "neutral") {
    return { signal: null, reason: "trend neutral — directional entry blocked" };
  }

  const direction = trend.trend === "bullish" ? "long" : "short";
  const level = direction === "long" ? sr.support : sr.resistance;
  if (!level) {
    return { signal: null, reason: `no ${direction === "long" ? "support" : "resistance"} level` };
  }

  const c1m = ctx.candles1m;
  const price = c1m.at(-1)?.close ?? 0;

  // Find the most recent sweep candle: wick pierces the level.
  const sweepIdx = findLastIndex(c1m, (c) =>
    direction === "long"
      ? c.low < level.price * (1 - SWEEP_PENETRATION)
      : c.high > level.price * (1 + SWEEP_PENETRATION),
  );
  if (sweepIdx === -1) {
    return { signal: null, reason: "no sweep candle found in 1m window" };
  }
  const sweepCandle = c1m[sweepIdx]!;

  // Reclaim: a later candle closes back on the correct side of the level.
  const reclaimIdx = c1m
    .slice(sweepIdx + 1)
    .findIndex((c) => (direction === "long" ? c.close > level.price : c.close < level.price));
  if (reclaimIdx === -1) {
    return { signal: null, reason: "swept but not reclaimed yet" };
  }
  const triggerCandle = c1m[sweepIdx + 1 + reclaimIdx]!;

  // Reclaim must be recent (within the last 5 candles) to be actionable.
  if (c1m.length - 1 - (sweepIdx + 1 + reclaimIdx) > 5) {
    return { signal: null, reason: "reclaim too old (stale setup)" };
  }

  // ── Trade levels ────────────────────────────────────────────────────────────
  const entryRef = level.price;
  const band = entryRef * 0.001;
  const entry_low = direction === "long" ? entryRef - band : entryRef;
  const entry_high = direction === "long" ? entryRef : entryRef + band;
  const entry = (entry_low + entry_high) / 2;

  const structuralSL =
    direction === "long"
      ? sweepCandle.low * (1 - SWEEP_PENETRATION)
      : sweepCandle.high * (1 + SWEEP_PENETRATION);
  const atr15m = atr(ctx.candles15m, rules.regime.atr_period);
  const sl = widenStopToAtr(entry, structuralSL, direction, atr15m, rules.risk);

  // TP: nearest opposite S/R level if it sits beyond entry, else a 3R projection.
  const oppLevel = direction === "long" ? sr.resistance : sr.support;
  const risk = Math.abs(entry - sl);
  const oppValid =
    oppLevel !== null &&
    (direction === "long" ? oppLevel.price > entry : oppLevel.price < entry);
  let tp = oppValid
    ? oppLevel!.price
    : direction === "long"
      ? entry + risk * 3
      : entry - risk * 3;

  const reward = Math.abs(tp - entry);
  const rr = risk === 0 ? 0 : reward / risk;

  // ── Scoring ─────────────────────────────────────────────────────────────────
  const closes15m = ctx.candles15m.map((c) => c.close);
  const ema20_4h = ema(ctx.candles4h.map((c) => c.close), 20);
  const htfAligned = Number.isFinite(ema20_4h)
    ? Math.abs(ema20_4h - level.price) / level.price <= HTF_TOLERANCE
    : false;

  // Sweep wick ratio: rejected wick vs body of the sweep candle.
  const body = Math.abs(sweepCandle.close - sweepCandle.open) || 1e-9;
  const wick =
    direction === "long"
      ? Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low
      : sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
  const sweepWickRatio = Math.max(0, wick) / body;

  const { confidence, parts: cParts } = scoreConfidence(
    { ctx, regime, regimeAligned: true },
    rules.confidence_weights,
  );
  const { setup_quality, parts: qParts } = scoreSetupQuality(
    {
      srLevel: level,
      triggerCandle,
      prevCandle: sweepCandle,
      htfAligned,
      sweepWickRatio,
      candles15m: ctx.candles15m,
    },
    rules.setup_quality_weights,
  );

  void closes15m; // (reserved for future structure checks)

  const signal: Signal = {
    symbol: ctx.symbol,
    strategy: "liquidity_sweep",
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
      price,
      support: sr.support,
      resistance: sr.resistance,
      funding_rate: ctx.fundingRate,
      open_interest: ctx.openInterest,
    },
    detected_at: Date.now(),
  };

  return { signal, reason: "sweep + reclaim confirmed" };
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

function r(n: number): number {
  // price rounding to a sensible precision
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
