// Offline synthetic market data. Deterministic per symbol so runs are
// reproducible. Crafted to land in a "ranging" regime with a bullish 4H trend
// and a fresh support sweep+reclaim on 1m — i.e. a textbook liquidity_sweep LONG.
//
// Used by `--mock` so the full pipeline can be exercised without network.
import type { Candle, MarketContext } from "../types.js";
import { buildSR } from "../strategy/sr-engine.js";

// mulberry32 — tiny seeded PRNG for reproducibility.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(symbol: string): number {
  let h = 2166136261;
  for (const ch of symbol) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function candle(time: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

/** Clean uptrend on 4H => fallback classifier reads bullish (price>ema20>ema50). */
function gen4h(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let price = base * 0.7;
  const step = (base * 0.3) / 200;
  for (let i = 0; i < 200; i++) {
    const o = price;
    price += step + (rand() - 0.45) * base * 0.004;
    const c = price;
    const h = Math.max(o, c) + rand() * base * 0.003;
    const l = Math.min(o, c) - rand() * base * 0.003;
    out.push(candle(i * 14400, o, h, l, c, 1000 + rand() * 200));
  }
  return out;
}

/**
 * Oscillating channel on 15m between support (base*0.98) and resistance
 * (base*1.02). Repeated bounces => the support/resistance get many touches
 * (high strength), the swing keeps ADX low (ranging), and steady amplitude
 * keeps ATR mid-percentile.
 */
function gen15m(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  const amp = base * 0.02; // 2% band each side
  // Short period => EMA20 ~= EMA50 (flat spread => ranging) and frequent
  // reversals keep ADX from registering a trend.
  const period = 12;
  const wave = (i: number) => base + amp * Math.sin((2 * Math.PI * i) / period);

  for (let i = 0; i < 200; i++) {
    const o = wave(i) + (rand() - 0.5) * base * 0.0006;
    const c = wave(i + 1) + (rand() - 0.5) * base * 0.0006;
    const h = Math.max(o, c) + rand() * base * 0.001;
    const l = Math.min(o, c) - rand() * base * 0.001;
    const v = i === 199 ? 5000 + rand() * 1000 : 800 + rand() * 400;
    out.push(candle(i * 900, o, h, l, c, v));
  }
  return out;
}

/** 1m: range near price, then sweep below `support`, then reclaim above it. */
function gen1m(price: number, support: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let p = price;
  // 196 ranging candles above support
  for (let i = 0; i < 196; i++) {
    const o = p;
    p += (price - p) * 0.2 + (rand() - 0.5) * price * 0.0015;
    if (p < support * 1.001) p = support * 1.002; // stay above support
    const c = p;
    const h = Math.max(o, c) + rand() * price * 0.0008;
    const l = Math.min(o, c) - rand() * price * 0.0008;
    out.push(candle(i * 60, o, h, l, c, 100 + rand() * 50));
  }
  // sweep candle: long lower wick piercing support, closes back near support
  const sweepLow = support * 0.994;
  out.push(candle(196 * 60, support * 1.001, support * 1.0015, sweepLow, support * 0.9995, 400));
  // reclaim candle: bullish, closes above support
  out.push(candle(197 * 60, support * 0.9995, support * 1.003, support * 0.999, support * 1.0025, 350));
  // follow-through
  out.push(candle(198 * 60, support * 1.0025, support * 1.004, support * 1.002, support * 1.0035, 250));
  out.push(candle(199 * 60, support * 1.0035, support * 1.005, support * 1.003, support * 1.004, 200));
  return out;
}

export async function buildMockContext(symbol: string, _category: string): Promise<MarketContext> {
  const rand = rng(hashSeed(symbol));
  const base = 100 + (hashSeed(symbol) % 50);

  const candles4h = gen4h(base, rand);
  const candles15m = gen15m(base, rand);
  const price = candles15m.at(-1)!.close;

  // Use the engine's own S/R so the 1m sweep targets a real detected support.
  const sr = buildSR(candles15m, price);
  const support = sr.support?.price ?? base * 0.99;
  const candles1m = gen1m(price, support, rand);

  // Extreme funding (bottom of the window) + rising OI => strong confidence.
  const fundingHistory = Array.from({ length: 200 }, () => (rand() - 0.5) * 0.0008);
  const fundingRate = Math.min(...fundingHistory) * 1.5; // more extreme than any historical
  const oiHistory = Array.from({ length: 200 }, (_, i) => 1_000_000 + i * 500 + rand() * 2000);
  const openInterest = oiHistory.at(-1)! + 80_000; // well above mean => high z-score

  return {
    symbol,
    candles1m,
    candles15m,
    candles4h,
    fundingRate,
    openInterest,
    fundingHistory,
    oiHistory,
  };
}
