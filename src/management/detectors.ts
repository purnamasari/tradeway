// Trade-management detectors — pure math over candles, no I/O.
//
// Three orthogonal reads on an open trade, all direction-relative ("against the
// trade" means bearish evidence for a long, bullish for a short):
//   detectRejection      — price is being refused at a level (wicks, failed
//                          breakout, fading directional volume, divergence)
//   detectMomentumDecay  — the move that justified entry is exhausting
//                          (volume/ATR contraction, ADX decline, RSI divergence,
//                          MACD histogram weakening)
//   detectLiquidityEvent — sweep / stop hunt / breakout trap around recent extremes
import type { Candle, Direction, SRSnapshot } from "../types.js";
import type { Rules } from "../config.js";
import { atr, adx, rsiSeries, macdHistogramSeries } from "../indicators.js";

type ManagementCfg = Rules["management"];

// ── Rejection detection ───────────────────────────────────────────────────────

export interface RejectionResult {
  /** True when >= 2 independent rejection signals are present. */
  risk: boolean;
  signals: string[];
  wickCount: number;
  failedBreakout: boolean;
  volumeDeclining: boolean;
  bodiesWeakening: boolean;
  divergence: boolean;
}

/** Wick pointing against the trade: upper wick for a long, lower wick for a short. */
function adverseWick(c: Candle, direction: Direction): number {
  return direction === "long"
    ? c.high - Math.max(c.open, c.close)
    : Math.min(c.open, c.close) - c.low;
}

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

/** Sum of volume on candles moving WITH the trade direction. */
function directionalVolume(candles: Candle[], direction: Direction): number {
  return candles.reduce((sum, c) => {
    const withTrade = direction === "long" ? c.close >= c.open : c.close < c.open;
    return sum + (withTrade ? c.volume : 0);
  }, 0);
}

/**
 * Detect rejection at the far level (resistance for longs, support for shorts):
 * many trades never reach the SL — they get refused at a level and drift. Each
 * sub-check is cheap and independent; `risk` requires two or more so a single
 * noisy wick can't page the user.
 */
export function detectRejection(
  candles1m: Candle[],
  direction: Direction,
  sr: SRSnapshot,
  cfg: ManagementCfg,
): RejectionResult {
  const window = candles1m.slice(-cfg.rejection_window);
  const signals: string[] = [];
  if (window.length < cfg.rejection_window) {
    return {
      risk: false, signals, wickCount: 0, failedBreakout: false,
      volumeDeclining: false, bodiesWeakening: false, divergence: false,
    };
  }

  // 1. Repeated rejection wicks against the trade.
  const wickCount = window.filter(
    (c) => adverseWick(c, direction) >= cfg.rejection_wick_body * Math.max(body(c), 1e-9),
  ).length;
  if (wickCount >= cfg.rejection_wicks_min) {
    signals.push(`${wickCount} rejection wicks in last ${window.length}m`);
  }

  // 2. Failed breakout of the far level: traded beyond it intra-candle but closed back.
  const level = direction === "long" ? sr.resistance : sr.support;
  let failedBreakout = false;
  if (level) {
    failedBreakout = window.slice(-5).some((c) =>
      direction === "long"
        ? c.high > level.price && c.close < level.price
        : c.low < level.price && c.close > level.price,
    );
    if (failedBreakout) {
      signals.push(
        `failed breakout ${direction === "long" ? "above resistance" : "below support"} ${fmt(level.price)}`,
      );
    }
  }

  // 3. Directional volume declining: with-trade volume, second half vs first half.
  const half = Math.floor(window.length / 2);
  const earlyVol = directionalVolume(window.slice(0, half), direction);
  const lateVol = directionalVolume(window.slice(-half), direction);
  const volumeDeclining =
    earlyVol > 0 && lateVol < earlyVol * (1 - cfg.volume_decline_pct / 100);
  if (volumeDeclining) {
    const dropPct = Math.round((1 - lateVol / earlyVol) * 100);
    signals.push(`${direction === "long" ? "buy" : "sell"} volume −${dropPct}%`);
  }

  // 4. Candle bodies weakening: recent 3 vs the prior bars of the window.
  const recent = window.slice(-3);
  const prior = window.slice(0, -3);
  const avgRecent = recent.reduce((s, c) => s + body(c), 0) / recent.length;
  const avgPrior = prior.reduce((s, c) => s + body(c), 0) / Math.max(prior.length, 1);
  const bodiesWeakening =
    avgPrior > 0 && avgRecent < avgPrior * (1 - cfg.body_weakening_pct / 100);
  if (bodiesWeakening) signals.push("candle bodies weakening");

  // 5. Momentum divergence on the same window's closes.
  const divergence = rsiDivergence(window, direction);
  if (divergence) signals.push("momentum divergence (price extends, RSI fades)");

  return {
    risk: signals.length >= 2,
    signals,
    wickCount,
    failedBreakout,
    volumeDeclining,
    bodiesWeakening,
    divergence,
  };
}

// ── Momentum decay ────────────────────────────────────────────────────────────

export interface DecayResult {
  /** True when >= 2 exhaustion metrics fire. */
  fading: boolean;
  signals: string[];
  volumeContraction: boolean;
  atrContraction: boolean;
  adxDecline: boolean;
  rsiDivergence: boolean;
  macdWeakening: boolean;
}

/**
 * Momentum exhaustion on the 15m structure timeframe. The entry detectors prove
 * momentum EXISTS; this proves it is FADING — each metric compares "now" against
 * a lookback so it measures change, not absolute level.
 */
export function detectMomentumDecay(
  candles15m: Candle[],
  direction: Direction,
  cfg: ManagementCfg,
): DecayResult {
  const empty: DecayResult = {
    fading: false, signals: [], volumeContraction: false, atrContraction: false,
    adxDecline: false, rsiDivergence: false, macdWeakening: false,
  };
  const lookback = cfg.decay_lookback;
  if (candles15m.length < 30 + lookback) return empty;
  const signals: string[] = [];

  // Volume contraction: last 5 bars vs the prior 20.
  const recentVol = avg(candles15m.slice(-5).map((c) => c.volume));
  const priorVol = avg(candles15m.slice(-25, -5).map((c) => c.volume));
  const volumeContraction = priorVol > 0 && recentVol / priorVol < cfg.decay_vol_contraction;
  if (volumeContraction) {
    signals.push(`volume contracting (${Math.round((recentVol / priorVol) * 100)}% of prior)`);
  }

  // ATR contraction: volatility now vs `lookback` bars ago.
  const atrNow = atr(candles15m, 14);
  const atrThen = atr(candles15m.slice(0, -lookback), 14);
  const atrContraction =
    Number.isFinite(atrNow) && Number.isFinite(atrThen) && atrThen > 0 &&
    atrNow / atrThen < cfg.decay_atr_contraction;
  if (atrContraction) signals.push("ATR contracting");

  // ADX decline: trend strength rolling over.
  const adxNow = adx(candles15m, 14);
  const adxThen = adx(candles15m.slice(0, -lookback), 14);
  const adxDecline =
    Number.isFinite(adxNow) && Number.isFinite(adxThen) &&
    adxThen - adxNow >= cfg.decay_adx_drop;
  if (adxDecline) signals.push(`ADX falling (${Math.round(adxThen)}→${Math.round(adxNow)})`);

  // RSI divergence over the recent swing window.
  const divergence = rsiDivergence(candles15m.slice(-30), direction);
  if (divergence) signals.push("RSI divergence");

  // MACD histogram weakening: last 3 bars shrinking toward zero from the trade side.
  const hist = macdHistogramSeries(candles15m.map((c) => c.close));
  const h = hist.slice(-3);
  const macdWeakening =
    h.length === 3 &&
    (direction === "long"
      ? h[0]! > 0 && h[2]! < h[1]! && h[1]! < h[0]!
      : h[0]! < 0 && h[2]! > h[1]! && h[1]! > h[0]!);
  if (macdWeakening) signals.push("MACD histogram weakening");

  return {
    fading: signals.length >= 2,
    signals,
    volumeContraction,
    atrContraction,
    adxDecline,
    rsiDivergence: divergence,
    macdWeakening,
  };
}

// ── Liquidity events ──────────────────────────────────────────────────────────

export type LiquidityEventKind = "liquidity_sweep" | "stop_hunt" | "breakout_trap";

export interface LiquidityResult {
  event: LiquidityEventKind | null;
  /** "against" = adverse for this trade, "with" = supportive (e.g. stops swept then reclaimed). */
  bias: "against" | "with" | null;
  detail: string[];
}

const SWEEP_WINDOW = 20; // 1m candles examined
const SWEEP_RECENT = 3; // the sweep must be in the most recent bars
const SWEEP_VOL_MULT = 1.8; // sweep candle volume vs window average

/**
 * Sweep/trap detection on 1m candles: price takes out a recent extreme on a
 * volume spike, then closes back inside. Above the highs it is a breakout trap
 * for a long (bias against); below the lows it is a stop hunt (bias with the
 * long if reclaimed — liquidity grabbed, level defended). Mirrored for shorts.
 */
export function detectLiquidityEvent(
  candles1m: Candle[],
  direction: Direction,
  cfg: ManagementCfg,
): LiquidityResult {
  void cfg; // thresholds are structural constants; cfg reserved for future tuning
  if (candles1m.length < SWEEP_WINDOW) return { event: null, bias: null, detail: [] };
  const window = candles1m.slice(-SWEEP_WINDOW);
  const prior = window.slice(0, -SWEEP_RECENT);
  const recent = window.slice(-SWEEP_RECENT);
  const avgVol = avg(window.map((c) => c.volume)) || 1e-9;

  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));

  for (const c of recent) {
    const volSpike = c.volume >= SWEEP_VOL_MULT * avgVol;
    if (!volSpike) continue;

    // Swept the highs, closed back below them.
    if (c.high > priorHigh && c.close < priorHigh) {
      const detail = [
        `price swept high ${fmt(priorHigh)} (${fmt(c.high)})`,
        `volume spike ${(c.volume / avgVol).toFixed(1)}× average`,
        `closed back below ${fmt(priorHigh)}`,
      ];
      return direction === "long"
        ? { event: "breakout_trap", bias: "against", detail }
        : { event: "liquidity_sweep", bias: "with", detail };
    }

    // Swept the lows, closed back above them.
    if (c.low < priorLow && c.close > priorLow) {
      const detail = [
        `price swept low ${fmt(priorLow)} (${fmt(c.low)})`,
        `volume spike ${(c.volume / avgVol).toFixed(1)}× average`,
        `closed back above ${fmt(priorLow)}`,
      ];
      return direction === "long"
        ? { event: "stop_hunt", bias: "with", detail }
        : { event: "breakout_trap", bias: "against", detail };
    }
  }

  return { event: null, bias: null, detail: [] };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Direction-relative momentum divergence: price extends in the trade direction
 * (second half makes a more favorable extreme) while RSI at those extremes fades.
 * Split-half comparison — robust enough at this cost, no pivot bookkeeping.
 */
export function rsiDivergence(candles: Candle[], direction: Direction): boolean {
  if (candles.length < 20) return false;
  const closes = candles.map((c) => c.close);
  const rsi = rsiSeries(closes, 14);
  const half = Math.floor(candles.length / 2);

  const argExtreme = (from: number, to: number): number => {
    let best = from;
    for (let i = from; i < to; i++) {
      const better =
        direction === "long"
          ? candles[i]!.high > candles[best]!.high
          : candles[i]!.low < candles[best]!.low;
      if (better) best = i;
    }
    return best;
  };

  const i1 = argExtreme(0, half);
  const i2 = argExtreme(half, candles.length);
  const r1 = rsi[i1];
  const r2 = rsi[i2];
  if (r1 == null || r2 == null || !Number.isFinite(r1) || !Number.isFinite(r2)) return false;

  return direction === "long"
    ? candles[i2]!.high > candles[i1]!.high && r2 < r1 - 1
    : candles[i2]!.low < candles[i1]!.low && r2 > r1 + 1;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
  return n.toFixed(dp);
}
