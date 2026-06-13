// Offline synthetic market data. Deterministic per symbol so runs are
// reproducible. Supports multiple scenarios via MockScenario.
//
// Scenarios:
//   "sweep"    — ranging regime, bullish 1H trend, fresh support sweep+reclaim
//                → textbook liquidity_sweep LONG
//   "pullback" — trending regime, bullish 1H trend, pullback to support + bounce
//                → textbook trend_pullback LONG
//
// Used by `--mock` so the full pipeline can be exercised without network.
import type { Candle, MarketContext, MockScenario } from "../types.js";
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

// ── 1H generators ────────────────────────────────────────────────────────────

/** Clean uptrend on 1H => fallback classifier reads bullish (price>ema20>ema50). */
function gen1hBullish(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let price = base * 0.7;
  const step = (base * 0.3) / 200;
  for (let i = 0; i < 200; i++) {
    const o = price;
    price += step + (rand() - 0.45) * base * 0.004;
    const c = price;
    const h = Math.max(o, c) + rand() * base * 0.003;
    const l = Math.min(o, c) - rand() * base * 0.003;
    out.push(candle(i * 3600, o, h, l, c, 1000 + rand() * 200));
  }
  return out;
}

/** Clean downtrend on 1H => fallback classifier reads bearish (price<ema20<ema50). */
function gen1hBearish(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let price = base * 1.3;
  const step = -(base * 0.3) / 200;
  for (let i = 0; i < 200; i++) {
    const o = price;
    price += step + (rand() - 0.55) * base * 0.004;
    const c = price;
    const h = Math.max(o, c) + rand() * base * 0.003;
    const l = Math.min(o, c) - rand() * base * 0.003;
    out.push(candle(i * 3600, o, h, l, c, 1000 + rand() * 200));
  }
  return out;
}

function gen15mHighVol(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < 200; i++) {
    const o = price;
    price += (rand() - 0.5) * base * 0.001;
    const c = price;
    let h = Math.max(o, c) + rand() * base * 0.001;
    let l = Math.min(o, c) - rand() * base * 0.001;
    if (i >= 195) {
      h += base * 0.05;
      l -= base * 0.05;
    }
    out.push(candle(i * 900, o, h, l, c, 1000 + rand() * 500));
  }
  return out;
}

function gen1mNormal(price: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let p = price;
  for (let i = 0; i < 200; i++) {
    const o = p;
    p += (rand() - 0.5) * price * 0.0005;
    const c = p;
    const h = Math.max(o, c) + rand() * price * 0.0003;
    const l = Math.min(o, c) - rand() * price * 0.0003;
    out.push(candle(i * 60, o, h, l, c, 100 + rand() * 50));
  }
  return out;
}

// ── 15m generators ───────────────────────────────────────────────────────────

/**
 * Ranging 15m: oscillating channel between support (base*0.98) and resistance
 * (base*1.02). Repeated bounces => high-touch S/R, low ADX, mid ATR percentile.
 */
function gen15mRanging(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  const amp = base * 0.02;
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

/**
 * Trending 15m: consistent uptrend with strong directional movement.
 * High ADX, clear EMA spread => regime engine classifies as "trending".
 * Includes clear support/resistance pivots from swing lows/highs.
 */
function gen15mTrending(base: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let price = base * 0.85;
  const step = (base * 0.15) / 200;

  for (let i = 0; i < 200; i++) {
    const o = price;
    // Strong directional bias + small noise
    price += step + (rand() - 0.35) * base * 0.003;

    // Add periodic pullbacks to create swing lows (support pivots)
    if (i % 20 === 15) {
      price -= base * 0.008; // dip
    } else if (i % 20 === 16) {
      price += base * 0.006; // partial recovery
    }

    const c = price;
    const h = Math.max(o, c) + rand() * base * 0.002;
    const l = Math.min(o, c) - rand() * base * 0.002;
    const v = 800 + rand() * 400;
    out.push(candle(i * 900, o, h, l, c, v));
  }
  return out;
}

// ── 1m generators ────────────────────────────────────────────────────────────

/** 1m: range near price, then sweep below `support`, then reclaim above it. */
function gen1mSweep(price: number, support: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let p = price;
  for (let i = 0; i < 196; i++) {
    const o = p;
    p += (price - p) * 0.2 + (rand() - 0.5) * price * 0.0015;
    if (p < support * 1.001) p = support * 1.002;
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

/**
 * 1m pullback: price drifts down to support level, touches it, then bounces.
 * The last few candles form a clear pullback-to-support + bounce pattern.
 */
function gen1mPullback(price: number, support: number, rand: () => number): Candle[] {
  const out: Candle[] = [];
  let p = price;

  // 190 candles: gentle uptrend above support
  for (let i = 0; i < 190; i++) {
    const o = p;
    p += (rand() - 0.48) * price * 0.001;
    if (p < support * 1.003) p = support * 1.004;
    const c = p;
    const h = Math.max(o, c) + rand() * price * 0.0006;
    const l = Math.min(o, c) - rand() * price * 0.0006;
    out.push(candle(i * 60, o, h, l, c, 100 + rand() * 50));
  }

  // 5 candles: pullback drift toward support
  const pullbackTarget = support * 1.001;
  const driftStep = (p - pullbackTarget) / 5;
  for (let i = 0; i < 5; i++) {
    const o = p;
    p -= driftStep + (rand() - 0.5) * price * 0.0003;
    const c = Math.max(p, support * 0.999);
    const h = Math.max(o, c) + rand() * price * 0.0004;
    const l = Math.min(o, c) - rand() * price * 0.0003;
    out.push(candle((190 + i) * 60, o, h, l, c, 150 + rand() * 100));
  }

  // Touch candle: wick dips to support level (within 0.5% tolerance)
  const touchO = support * 1.002;
  const touchL = support * 0.999; // touches the level
  const touchC = support * 1.001;
  out.push(candle(195 * 60, touchO, support * 1.003, touchL, touchC, 300));

  // Bounce candle: bullish, closes above support (confirmation)
  const bounceO = support * 1.001;
  const bounceC = support * 1.005; // clearly above
  out.push(candle(196 * 60, bounceO, support * 1.006, support * 1.0005, bounceC, 350));

  // Follow-through candles
  out.push(candle(197 * 60, support * 1.005, support * 1.008, support * 1.004, support * 1.007, 250));
  out.push(candle(198 * 60, support * 1.007, support * 1.010, support * 1.006, support * 1.009, 200));
  out.push(candle(199 * 60, support * 1.009, support * 1.012, support * 1.008, support * 1.011, 180));

  return out;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function buildMockContext(
  symbol: string,
  _category: string,
  scenario: MockScenario = "sweep",
): Promise<MarketContext> {
  const rand = rng(hashSeed(symbol));
  const base = 100 + (hashSeed(symbol) % 50);

  const candles1h = scenario === "squeeze"
    ? (symbol.startsWith("ETH") ? gen1hBearish(base, rand) : gen1hBullish(base, rand))
    : gen1hBullish(base, rand);

  const candles15m = scenario === "pullback"
    ? gen15mTrending(base, rand)
    : scenario === "squeeze"
      ? gen15mHighVol(base, rand)
      : gen15mRanging(base, rand);

  const price = candles15m.at(-1)!.close;

  // Use the engine's own S/R so the 1m data targets a real detected support.
  const sr = buildSR(candles15m, price);
  const support = sr.support?.price ?? base * 0.99;

  const candles1m = scenario === "pullback"
    ? gen1mPullback(price, support, rand)
    : scenario === "squeeze"
      ? gen1mNormal(price, rand)
      : gen1mSweep(price, support, rand);

  let fundingHistory: number[];
  let fundingRate: number;
  let oiHistory: number[];
  let openInterest: number;

  if (scenario === "squeeze") {
    if (symbol.startsWith("ETH")) {
      // Long squeeze -> SHORT signal: extreme positive funding + falling OI
      fundingHistory = Array.from({ length: 200 }, () => (rand() - 0.5) * 0.0002);
      fundingRate = 0.003;
      oiHistory = Array.from({ length: 200 }, (_, i) => 1_000_000 - i * 500 + (rand() - 0.5) * 1000);
      openInterest = 850_000;
    } else {
      // Short squeeze -> LONG signal: extreme negative funding + rising OI
      fundingHistory = Array.from({ length: 200 }, () => (rand() - 0.5) * 0.0002);
      fundingRate = -0.003;
      oiHistory = Array.from({ length: 200 }, (_, i) => 1_000_000 + i * 500 + (rand() - 0.5) * 1000);
      openInterest = 1_150_000;
    }
  } else {
    // Extreme funding (bottom of the window) + rising OI => strong confidence.
    fundingHistory = Array.from({ length: 200 }, () => (rand() - 0.5) * 0.0008);
    fundingRate = Math.min(...fundingHistory) * 1.5;
    oiHistory = Array.from({ length: 200 }, (_, i) => 1_000_000 + i * 500 + (rand() - 0.5) * 2000);
    openInterest = oiHistory.at(-1)! + 80_000;
  }

  return {
    symbol,
    candles1m,
    candles15m,
    candles1h,
    candles1w: [],
    fundingRate,
    openInterest,
    fundingHistory,
    oiHistory,
    historyConfidence: 1.0,
  };
}
