// Pure-math technical indicators. No state, no I/O.
import type { Candle } from "./types.js";

/** Exponential moving average over the given series. Returns the latest value. */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return NaN;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values for stability.
  const seedLen = Math.min(period, values.length);
  let prev = values.slice(0, seedLen).reduce((a, b) => a + b, 0) / seedLen;
  for (let i = seedLen; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

/** Full EMA series (same length as input), seeded with the first value. */
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? NaN;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i]! : values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** True range for each candle (index 0 uses high-low only). */
function trueRanges(candles: Candle[]): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      tr.push(c.high - c.low);
      continue;
    }
    const prevClose = candles[i - 1]!.close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return tr;
}

/** Wilder's ATR. Returns the latest smoothed value. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const tr = trueRanges(candles);
  let a = tr.slice(1, period + 1).reduce((x, y) => x + y, 0) / period;
  for (let i = period + 1; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]!) / period;
  }
  return a;
}

/** ATR computed for each candle index (Wilder), for percentile windows. */
export function atrSeries(candles: Candle[], period = 14): number[] {
  const tr = trueRanges(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let a = tr.slice(1, period + 1).reduce((x, y) => x + y, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]!) / period;
    out[i] = a;
  }
  return out;
}

/** Wilder's ADX (trend strength, 0-100). Returns the latest value. */
export function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return NaN;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr = trueRanges(candles);

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  // Wilder smoothing
  const smooth = (arr: number[]): number[] => {
    const s: number[] = new Array(arr.length).fill(0);
    let sum = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    s[period] = sum;
    for (let i = period + 1; i < arr.length; i++) {
      sum = sum - sum / period + arr[i]!;
      s[i] = sum;
    }
    return s;
  };

  const sTR = smooth(tr);
  const sPlus = smooth(plusDM);
  const sMinus = smooth(minusDM);

  const dx: number[] = [];
  for (let i = period; i < candles.length; i++) {
    const plusDI = sTR[i]! === 0 ? 0 : (100 * sPlus[i]!) / sTR[i]!;
    const minusDI = sTR[i]! === 0 ? 0 : (100 * sMinus[i]!) / sTR[i]!;
    const denom = plusDI + minusDI;
    dx.push(denom === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / denom);
  }

  if (dx.length < period) return NaN;
  // ADX = Wilder average of DX
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]!) / period;
  }
  return adxVal;
}

/** Wilder RSI for each index (NaN until `period` values exist). */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD histogram (macd line − signal line) for each index. */
export function macdHistogramSeries(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): number[] {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const macd = closes.map((_, i) => f[i]! - s[i]!);
  const sig = emaSeries(macd, signal);
  return macd.map((m, i) => m - sig[i]!);
}

/** Percentile rank (0-100) of `value` within `window`. */
export function percentileRank(value: number, window: number[]): number {
  const clean = window.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 50;
  const below = clean.filter((v) => v <= value).length;
  return (below / clean.length) * 100;
}

/** z-score of `value` relative to `window`. */
export function zScore(value: number, window: number[]): number {
  const clean = window.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (value - mean) / sd;
}
