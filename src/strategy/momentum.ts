// Momentum / breakout detector.
// Rides a fast directional move instead of fading it. Enters in the move's
// direction with an ATR-sized stop.
//
// Gating:
//   regime must allow momentum (all live regimes — see regime/engine.ts)
//   HTF guard: block only if the 15m trend is *strictly opposite* the move.
import type {
  MarketContext,
  RegimeResult,
  Signal,
  SRSnapshot,
  TrendResult,
  ScoreBreakdown,
  Direction,
} from "../types.js";
import type { Rules } from "../config.js";
import { atr, ema, percentileRank } from "../indicators.js";
import { scoreSetupQuality } from "../scoring.js";
import { widenStopToAtr } from "../risk.js";

export interface DetectResult {
  signal: Signal | null;
  reason: string;
}

export function detectMomentum(
  ctx: MarketContext,
  regime: RegimeResult,
  trend: TrendResult,
  sr: SRSnapshot,
  rules: Rules,
): DetectResult {
  const cfg = rules.momentum;
  if (!cfg.enabled) return { signal: null, reason: "momentum disabled" };
  if (!regime.allowedStrategies.includes("momentum")) {
    return { signal: null, reason: `regime ${regime.regime} blocks momentum` };
  }

  const c1m = ctx.candles1m;
  if (c1m.length < cfg.lookback_1m + 2) {
    return { signal: null, reason: "insufficient 1m candles for momentum window" };
  }

  // ── Measure the move over the window ────────────────────────────────────────
  const window = c1m.slice(-cfg.lookback_1m);
  const startPrice = window[0]!.open;
  const last = c1m.at(-1)!;
  const nowPrice = last.close;
  const movePct = ((nowPrice - startPrice) / startPrice) * 100;
  const absMove = Math.abs(movePct);
  if (absMove < cfg.min_move_pct) {
    return { signal: null, reason: `move ${movePct.toFixed(2)}% < ${cfg.min_move_pct}%` };
  }

  const direction: Direction = movePct > 0 ? "long" : "short";

  // Latest candle must keep pushing in the move direction.
  const continues = direction === "long" ? last.close > last.open : last.close < last.open;
  if (!continues) return { signal: null, reason: "latest 1m candle not continuing the move" };

  // Reject a blow-off where the move is almost entirely the final bar (poor entry).
  const finalContribution = Math.abs(last.close - last.open);
  const totalMove = Math.abs(nowPrice - startPrice) || 1e-9;
  const finalFrac = finalContribution / totalMove;
  if (finalFrac > cfg.max_final_candle_frac) {
    return { signal: null, reason: `blow-off bar (${(finalFrac * 100).toFixed(0)}% of move in one candle)` };
  }

  // Volume confirmation vs the window average.
  const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length || 1e-9;
  const volRatio = last.volume / avgVol;
  if (volRatio < cfg.vol_mult) {
    return { signal: null, reason: `volume ${volRatio.toFixed(2)}x < ${cfg.vol_mult}x avg` };
  }

  // ── HTF guard: use 15m trend for intraday responsiveness ────────────────────
  const closes15m = ctx.candles15m.map((c) => c.close);
  const ema20_15m = ema(closes15m, 20);
  const ema50_15m = ema(closes15m, 50);
  const trend15m: "bullish" | "bearish" | "neutral" =
    ema20_15m > ema50_15m * 1.001 ? "bullish" :
    ema20_15m < ema50_15m * 0.999 ? "bearish" : "neutral";

  if (direction === "long" && trend15m === "bearish") {
    return { signal: null, reason: "long blocked — 15m trend bearish" };
  }
  if (direction === "short" && trend15m === "bullish") {
    return { signal: null, reason: "short blocked — 15m trend bullish" };
  }

  // ── Trade levels ────────────────────────────────────────────────────────────
  const entryRef = nowPrice;
  const band = entryRef * 0.003; // 0.3% entry band for fast moves
  const entry_low = entryRef - band;
  const entry_high = entryRef + band;
  const entry = entryRef;

  // SL: the base of the move (window extreme), widened to ATR.
  // Also consider 15m structure for a more robust stop.
  const windowExtreme =
    direction === "long"
      ? Math.min(...window.map((c) => c.low))
      : Math.max(...window.map((c) => c.high));
  const atr15m = atr(ctx.candles15m, rules.regime.atr_period);
  const sl = widenStopToAtr(entry, windowExtreme, direction, atr15m, rules.risk);
  const risk = Math.abs(entry - sl);

  // TP: next S/R in direction (if at least 1R away), else an R-multiple target.
  const target = direction === "long" ? sr.resistance : sr.support;
  const targetValid =
    target !== null && (direction === "long" ? target.price > entry + risk : target.price < entry - risk);
  const tp = targetValid
    ? target!.price
    : direction === "long"
      ? entry + risk * cfg.tp_r
      : entry - risk * cfg.tp_r;
  const reward = Math.abs(tp - entry);
  const rr = risk === 0 ? 0 : reward / risk;

  // ── Confidence: momentum-specific (move magnitude + volume), NOT funding/OI ──
  // A qualifying move starts at 55; magnitude and volume add up to 45 more.
  const moveScore = clamp01((absMove - cfg.min_move_pct) / cfg.min_move_pct);
  const volScore = clamp01((volRatio - cfg.vol_mult) / cfg.vol_mult);
  const confidence = Math.round(Math.min(100, 55 + moveScore * 30 + volScore * 15));

  // ── Setup quality: momentum-specific scoring ────────────────────────────────
  // Rewards velocity, volume, and 15m trend alignment instead of S/R levels.
  const htfAligned =
    (direction === "long" && trend15m === "bullish") ||
    (direction === "short" && trend15m === "bearish");

  // Velocity score: how clean is the move (monotonic = higher score).
  const velocityScore = window.length >= 2 ? velocityClean(window, direction) : 0.5;

  // Volume score: already confirmed by gate, but quality scales with strength.
  const volQuality = clamp01((volRatio - cfg.vol_mult) / cfg.vol_mult);

  // Combine: velocity (30%) + volume (30%) + HTF alignment (20%) + structure (20%).
  const setup_quality = Math.round(Math.min(100,
    velocityScore * 30 + volQuality * 30 + (htfAligned ? 20 : 0) + (targetValid ? 20 : 0)
  ));

  // Surrogate confidence breakdown for the alert's explainability block.
  const cParts: ScoreBreakdown = {
    funding_percentile: 50,
    oi_zscore: 0,
    volume_percentile: Math.round(percentileRank(last.volume, window.map((c) => c.volume))),
    regime_alignment: 10,
    sr_level_strength: targetValid ? (target?.strength ?? 0) : 0,
    engulf_body_ratio: round(Math.abs(last.close - last.open) / (Math.abs(c1m.at(-2)!.close - c1m.at(-2)!.open) || 1e-9), 2),
    htf_aligned: htfAligned,
    structure_intact: velocityScore > 0.7,
    sweep_wick_ratio: undefined,
  };

  const signal: Signal = {
    symbol: ctx.symbol,
    strategy: "momentum",
    direction,
    entry_low: r(entry_low),
    entry_high: r(entry_high),
    sl: r(sl),
    tp: r(tp),
    rr: round(rr, 2),
    confidence,
    setup_quality,
    score_breakdown: { ...cParts },
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

  return {
    signal,
    reason: `momentum ${direction} ${movePct.toFixed(2)}% move, vol ${volRatio.toFixed(2)}x`,
  };
}

/** How monotonic is the move: 1.0 = every candle in direction, 0.0 = mixed. */
function velocityClean(candles: { close: number; open: number }[], direction: Direction): number {
  if (candles.length < 2) return 0.5;
  let aligned = 0;
  for (const c of candles) {
    if (direction === "long" && c.close >= c.open) aligned++;
    else if (direction === "short" && c.close <= c.open) aligned++;
  }
  return aligned / candles.length;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
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
