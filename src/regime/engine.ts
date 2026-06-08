// Regime Engine — rule-based, no AI dependency. Answers:
// "What strategies does the current market condition allow?"
// Inputs are pure math on 15m candles (ADX, ATR percentile, EMA spread).
import type { Candle, RegimeResult, StrategyKind } from "../types.js";
import type { Rules } from "../config.js";
import { adx, atr, atrSeries, ema, percentileRank } from "../indicators.js";

// Momentum is allowed across all live regimes (not just one) so a fast directional
// move is caught even when the lagging 15m regime label misclassifies it. Squeeze is
// still listed for high_volatility but is gated off by rules.squeeze.enabled.
const ALLOWED: Record<RegimeResult["regime"], StrategyKind[]> = {
  trending: ["trend_pullback", "momentum"],
  ranging: ["liquidity_sweep", "momentum"],
  high_volatility: ["squeeze", "momentum"],
  low_volatility: [],
};

export function classifyRegime(candles15m: Candle[], rules: Rules["regime"], atrHistory?: number[]): RegimeResult {
  const closes = candles15m.map((c) => c.close);
  const adxVal = adx(candles15m, rules.adx_period);
  const emaFast = ema(closes, rules.ema_fast);
  const emaSlow = ema(closes, rules.ema_slow);
  const emaSpreadPct = emaSlow === 0 ? 0 : Math.abs(emaFast - emaSlow) / emaSlow;

  // ATR percentile vs its own recent history (proxy for the 30d window).
  const atrNow = atr(candles15m, rules.atr_period);
  const atrHist = atrHistory && atrHistory.length >= 50
    ? atrHistory
    : atrSeries(candles15m, rules.atr_period).filter(Number.isFinite);
  const atrPct = percentileRank(atrNow, atrHist);

  let regime: RegimeResult["regime"];
  if (atrPct >= rules.high_vol_atr_pct) {
    regime = "high_volatility";
  } else if (atrPct <= rules.low_vol_atr_pct) {
    regime = "low_volatility";
  } else if (adxVal >= rules.trending_adx && emaSpreadPct >= rules.ema_spread_flat) {
    regime = "trending";
  } else {
    // ADX below trending threshold, or EMAs flat => ranging.
    regime = "ranging";
  }

  return {
    regime,
    adx: round(adxVal),
    atrPercentile: round(atrPct),
    emaSpreadPct: round(emaSpreadPct, 4),
    allowedStrategies: ALLOWED[regime],
    computedAt: Date.now(),
  };
}

function round(n: number, dp = 1): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
