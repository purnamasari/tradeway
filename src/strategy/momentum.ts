// Momentum / breakout detector.
// Rides a fast directional move instead of fading it (the gap that left clean 2%
// spikes undetected — they land in high_volatility where only the counter-trend
// squeeze used to fire). Enters in the move's direction with an ATR-sized stop.
//
// Gating:
//   regime must allow momentum (every live regime does — see regime/engine.ts)
//   HTF guard: block only if the 4h trend is *strictly opposite* the move.
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
import { atr, percentileRank } from "../indicators.js";
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

  // HTF guard: only block a move that fights a committed 4h trend.
  if (direction === "long" && trend.trend === "bearish") {
    return { signal: null, reason: "long blocked — 4h trend bearish" };
  }
  if (direction === "short" && trend.trend === "bullish") {
    return { signal: null, reason: "short blocked — 4h trend bullish" };
  }

  // ── Trade levels ────────────────────────────────────────────────────────────
  const entryRef = nowPrice;
  const band = entryRef * 0.001;
  const entry_low = entryRef - band;
  const entry_high = entryRef + band;
  const entry = entryRef;

  // SL: the base of the move (window extreme), widened to ATR.
  const structuralSL =
    direction === "long"
      ? Math.min(...window.map((c) => c.low))
      : Math.max(...window.map((c) => c.high));
  const atr15m = atr(ctx.candles15m, rules.regime.atr_period);
  const sl = widenStopToAtr(entry, structuralSL, direction, atr15m, rules.risk);
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
  // A qualifying move starts at 60; magnitude and volume add up to 40 more. The
  // funding/OI confidence model would score ~40 here and be gated out, so momentum
  // needs its own — this is what lets real 2% spikes clear min_confidence.
  const moveScore = clamp01((absMove - cfg.min_move_pct) / cfg.min_move_pct);
  const volScore = clamp01((volRatio - cfg.vol_mult) / cfg.vol_mult);
  const confidence = Math.round(Math.min(100, 60 + moveScore * 25 + volScore * 15));

  const htfAligned =
    (direction === "long" && trend.trend === "bullish") ||
    (direction === "short" && trend.trend === "bearish");
  const prevCandle = c1m.at(-2) ?? last;
  const { setup_quality, parts: qParts } = scoreSetupQuality(
    {
      srLevel: targetValid ? target : null,
      triggerCandle: last,
      prevCandle,
      htfAligned,
      candles15m: ctx.candles15m,
    },
    rules.setup_quality_weights,
  );

  // Surrogate confidence breakdown for the alert's explainability block.
  const cParts: Pick<
    ScoreBreakdown,
    "funding_percentile" | "oi_zscore" | "volume_percentile" | "regime_alignment"
  > = {
    funding_percentile: 50,
    oi_zscore: 0,
    volume_percentile: Math.round(percentileRank(last.volume, window.map((c) => c.volume))),
    regime_alignment: 10,
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

  return {
    signal,
    reason: `momentum ${direction} ${movePct.toFixed(2)}% move, vol ${volRatio.toFixed(2)}x`,
  };
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
