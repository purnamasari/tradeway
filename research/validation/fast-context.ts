// Precomputed per-symbol context for the validation framework. The expensive
// per-bar work (regime classification, ATRs) does not depend on strategy
// parameters, so it is computed ONCE per symbol and shared across every fee
// level, sweep combination, and walk-forward fold. The computations replicate
// research/harness.ts exactly so canonical results reproduce.
import type { Candle } from "../../src/types.js";
import type { Rules } from "../../src/config.js";
import { classifyRegime } from "../../src/regime/engine.js";
import { atr, atrSeries } from "../../src/indicators.js";
import { loadSymbolCache } from "../harness.js";

export const WARMUP_BARS = 30 * 96; // identical to the harness warmup
const BARS_30D = 30 * 96;

export interface FastContext {
  symbol: string;
  candles: Candle[];
  closes: number[];
  atr15: number[]; // ATR(14) on 15m, per bar (NaN during warmup)
  atr1h: number[]; // ATR(14) on the trailing 1h aggregation, per bar
  regime: string[]; // regime label per bar ("" before warmup)
  /** Cross-run memoization slot (e.g. rolling channels per lookback). */
  cache: Map<string, unknown>;
}

export function buildFastContext(symbol: string, candles: Candle[], rules: Rules): FastContext {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const atr15 = atrSeries(candles, rules.regime.atr_period);
  const atr1h = new Array<number>(n).fill(NaN);
  const regime = new Array<string>(n).fill("");

  // Incremental 1h aggregation, same as harness (partial current hour included).
  const c1h: Candle[] = [];
  const pushBar = (bar: Candle) => {
    const bucket = bar.time - (bar.time % 3600);
    const last = c1h[c1h.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
    } else {
      c1h.push({ time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    }
  };
  for (let i = 0; i < Math.min(WARMUP_BARS, n); i++) pushBar(candles[i]!);

  for (let i = WARMUP_BARS; i < n; i++) {
    pushBar(candles[i]!);
    const win15 = candles.slice(Math.max(0, i - 319), i + 1);
    const atrHist = atr15.slice(Math.max(0, i - BARS_30D), i + 1).filter(Number.isFinite);
    regime[i] = classifyRegime(win15, rules.regime, atrHist).regime;
    atr1h[i] = atr(c1h.slice(-120), 14);
  }
  return { symbol, candles, closes, atr15, atr1h, regime, cache: new Map() };
}

export function loadContexts(symbols: string[], prefix: string, rules: Rules): FastContext[] {
  return symbols.map((s) => {
    const t0 = Date.now();
    const ctx = buildFastContext(s, loadSymbolCache(prefix + s).candles15m, rules);
    console.error(`[ctx] ${prefix}${s}: ${ctx.candles.length} bars in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return ctx;
  });
}
