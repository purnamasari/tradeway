// Offline check for the momentum detector + ATR stop sizing. No DB, no network.
//   pnpm test:momentum
import { loadRules } from "./config.js";
import { detectMomentum } from "./strategy/momentum.js";
import { widenStopToAtr } from "./risk.js";
import type { Candle, MarketContext, RegimeResult, TrendResult, SRSnapshot } from "./types.js";

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

function candle(time: number, o: number, h: number, l: number, c: number, v: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

// 60 15m candles with a steady ~1.2-wide range → ATR ≈ 1.2 (≈1.2% of price).
function candles15m(): Candle[] {
  return Array.from({ length: 60 }, (_, i) => candle(i * 900, 100, 100.6, 99.4, 100, 1000));
}

// 1m series: 13 flat candles, then a 7-candle +2% ramp on rising volume.
function spike1m(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 13; i++) out.push(candle(i * 60, 100, 100.05, 99.95, 100, 100));
  const ramp = [100.0, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102.0];
  for (let i = 0; i < 7; i++) {
    const o = ramp[i]!;
    const c = ramp[i + 1]!;
    out.push(candle((13 + i) * 60, o, c + 0.02, o - 0.02, c, 100 + i * 30 + (i === 6 ? 200 : 0)));
  }
  return out;
}

function flat1m(): Candle[] {
  return Array.from({ length: 20 }, (_, i) => candle(i * 60, 100, 100.05, 99.95, 100, 100));
}

function ctxWith(c1m: Candle[]): MarketContext {
  return {
    symbol: "TESTUSDT",
    candles1m: c1m,
    candles15m: candles15m(),
    candles1h: [],
    fundingRate: 0,
    openInterest: 0,
    fundingHistory: [],
    oiHistory: [],
    historyConfidence: 0,
  };
}

const regime: RegimeResult = {
  regime: "high_volatility",
  adx: 20,
  atrPercentile: 90,
  emaSpreadPct: 0.002,
  allowedStrategies: ["squeeze", "momentum"],
  computedAt: Date.now(),
};
const trendNeutral: TrendResult = { trend: "neutral", confidence: 50, source: "ema_adx_fallback" };
const trendBearish: TrendResult = { trend: "bearish", confidence: 70, source: "ema_adx_fallback" };
const sr: SRSnapshot = { support: null, resistance: null, levels: [] };

const rules = loadRules();

console.log("── widenStopToAtr ─────────────────────────────────────────");
const sl = widenStopToAtr(100, 99.5, "long", 1.0, rules.risk); // 0.5% structural, 1% ATR
ok("widens a 0.5% structural stop to ATR", sl < 99.5 && Math.abs(100 - sl) > 1.0, `sl=${sl.toFixed(3)} (dist=${(100 - sl).toFixed(2)})`);

console.log("\n── detectMomentum ─────────────────────────────────────────");
const spike = detectMomentum(ctxWith(spike1m()), regime, trendNeutral, sr, rules);
ok("fires LONG on a +2% spike", spike.signal !== null && spike.signal.direction === "long", spike.reason);
if (spike.signal) {
  const mid = (spike.signal.entry_low + spike.signal.entry_high) / 2;
  const slPct = (Math.abs(mid - spike.signal.sl) / mid) * 100;
  ok("stop is ATR-sized (> 0.5%), not the old flat floor", slPct > 0.5, `SL=${slPct.toFixed(2)}%`);
  ok("confidence clears the default gate (>=65)", spike.signal.confidence >= 65, `conf=${spike.signal.confidence}`);
}

const flat = detectMomentum(ctxWith(flat1m()), regime, trendNeutral, sr, rules);
ok("rejects a flat series", flat.signal === null, flat.reason);

const opposed = detectMomentum(ctxWith(spike1m()), regime, trendBearish, sr, rules);
ok("blocks a long spike when 1h trend is strictly bearish", opposed.signal === null, opposed.reason);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
