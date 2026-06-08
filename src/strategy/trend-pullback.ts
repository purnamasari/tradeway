// Trend Pullback detector.
// Pattern: price pulls back to an S/R level in a trending regime, then
// bounces (confirmed by a 1m candle closing back in the trend direction).
//
// Gating (per Regime × Trend table):
//   regime must allow trend_pullback (trending)
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

const PULLBACK_TOLERANCE = 0.005; // price within 0.5% of S/R level counts as "at the level"
const HTF_TOLERANCE = 0.005; // 1H EMA within 0.5% of the S/R level => aligned
const LOOKBACK_1M = 10; // how far back in 1m candles to look for the pullback touch

export interface DetectResult {
  signal: Signal | null;
  reason: string;
}

export function detectTrendPullback(
  ctx: MarketContext,
  regime: RegimeResult,
  trend: TrendResult,
  sr: SRSnapshot,
  rules: Rules,
): DetectResult {
  if (!regime.allowedStrategies.includes("trend_pullback")) {
    return { signal: null, reason: `regime ${regime.regime} blocks trend_pullback` };
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

  // ── Find pullback touch ────────────────────────────────────────────────────
  // A candle whose wick reaches within PULLBACK_TOLERANCE of the S/R level.
  const recentCandles = c1m.slice(-LOOKBACK_1M);
  const touchIdx = findLastIndex(recentCandles, (c) =>
    direction === "long"
      ? c.low <= level.price * (1 + PULLBACK_TOLERANCE) && c.low >= level.price * (1 - PULLBACK_TOLERANCE)
      : c.high >= level.price * (1 - PULLBACK_TOLERANCE) && c.high <= level.price * (1 + PULLBACK_TOLERANCE),
  );
  if (touchIdx === -1) {
    return { signal: null, reason: "no pullback touch near S/R level in recent 1m candles" };
  }

  // ── Find bounce confirmation ───────────────────────────────────────────────
  // A candle *after* the touch that closes in the trend direction (away from level).
  const afterTouch = recentCandles.slice(touchIdx + 1);
  const bounceCandle = afterTouch.find((c) =>
    direction === "long"
      ? c.close > level.price && c.close > c.open // bullish candle above level
      : c.close < level.price && c.close < c.open, // bearish candle below level
  );
  if (!bounceCandle) {
    return { signal: null, reason: "pullback touched S/R but no bounce confirmation yet" };
  }

  // Bounce must be one of the last 3 candles to be actionable.
  const bounceAge = c1m.length - 1 - c1m.indexOf(bounceCandle);
  if (bounceAge > 3) {
    return { signal: null, reason: "bounce too old (stale setup)" };
  }

  const touchCandle = recentCandles[touchIdx]!;

  // ── Trade levels ───────────────────────────────────────────────────────────
  const entryRef = level.price;
  const band = entryRef * 0.001;
  const entry_low = direction === "long" ? entryRef - band : entryRef;
  const entry_high = direction === "long" ? entryRef : entryRef + band;
  const entry = (entry_low + entry_high) / 2;

  // SL: beyond the pullback extreme, then widened to ATR so it isn't inside the noise.
  const structuralSL =
    direction === "long"
      ? touchCandle.low * 0.998 // slightly below the pullback low
      : touchCandle.high * 1.002; // slightly above the pullback high
  const atr15m = atr(ctx.candles15m, rules.regime.atr_period);
  const sl = widenStopToAtr(entry, structuralSL, direction, atr15m, rules.risk);

  // TP: nearest opposite S/R level or a 3R projection.
  const oppLevel = direction === "long" ? sr.resistance : sr.support;
  const risk = Math.abs(entry - sl);
  const oppValid =
    oppLevel !== null &&
    (direction === "long" ? oppLevel.price > entry : oppLevel.price < entry);
  const tp = oppValid
    ? oppLevel!.price
    : direction === "long"
      ? entry + risk * 3
      : entry - risk * 3;

  const reward = Math.abs(tp - entry);
  const rr = risk === 0 ? 0 : reward / risk;

  // ── Scoring ────────────────────────────────────────────────────────────────
  const ema20_1h = ema(ctx.candles1h.map((c) => c.close), 20);
  const htfAligned = Number.isFinite(ema20_1h)
    ? Math.abs(ema20_1h - level.price) / level.price <= HTF_TOLERANCE
    : false;

  const prevCandle = c1m[c1m.indexOf(bounceCandle) - 1] ?? touchCandle;

  const { confidence, parts: cParts } = scoreConfidence(
    { ctx, regime, regimeAligned: true },
    rules.confidence_weights,
  );
  const { setup_quality, parts: qParts } = scoreSetupQuality(
    {
      srLevel: level,
      triggerCandle: bounceCandle,
      prevCandle,
      htfAligned,
      // no sweepWickRatio — that's liquidity_sweep specific
      candles15m: ctx.candles15m,
    },
    rules.setup_quality_weights,
  );

  const signal: Signal = {
    symbol: ctx.symbol,
    strategy: "trend_pullback",
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

  return { signal, reason: "pullback + bounce confirmed" };
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
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
