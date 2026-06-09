// Offline checks for the backtest fill model + a replay smoke test. No network.
//   pnpm test:backtest
import { simulateOutcome, type SimSignal } from "./backtest/simulate.js";
import { replaySymbol } from "./backtest/engine.js";
import { loadRules, loadWatchlist } from "./config.js";
import type { Candle } from "./types.js";

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

const costs = { feePct: 0.11, slippagePct: 0.02 };
function c(time: number, o: number, h: number, l: number, cl: number, v = 100): Candle {
  return { time, open: o, high: h, low: l, close: cl, volume: v };
}

// Long momentum: entry ~100, SL 99 (1.0 risk), TP 103 (3R target).
const sig: SimSignal = { strategy: "momentum", direction: "long", entry_low: 99.95, entry_high: 100.05, sl: 99, tp: 103, detected_at: 0 };

console.log("── fill model ─────────────────────────────────────────────");

// TP: enter, then a candle reaches 103.
{
  const r = simulateOutcome(sig, [c(60, 100, 100.1, 99.9, 100), c(120, 101, 103.5, 100.5, 103)], costs);
  ok("TP hit (≈3R minus costs)", r.status === "TP" && r.rMultiple > 2.5 && r.rMultiple < 3, `${r.status} R=${r.rMultiple.toFixed(2)}`);
}
// SL: enter, then a candle reaches 99.
{
  const r = simulateOutcome(sig, [c(60, 100, 100.1, 99.9, 100), c(120, 99.5, 99.6, 98.5, 98.7)], costs);
  ok("SL hit (≈-1R minus costs)", r.status === "SL" && r.rMultiple < -0.9, `${r.status} R=${r.rMultiple.toFixed(2)}`);
}
// Ambiguous: one candle spans both SL and TP → SL-first (pessimistic).
{
  const r = simulateOutcome(sig, [c(60, 100, 100.1, 99.9, 100), c(120, 100, 103.5, 98.5, 100)], costs);
  ok("ambiguous candle → SL-first", r.status === "SL", r.status);
}
// NO_FILL: band never touched within the entry window.
{
  const fwd = Array.from({ length: 40 }, (_, i) => c((i + 1) * 60, 105, 106, 104.9, 105));
  const r = simulateOutcome(sig, fwd, costs);
  ok("no fill when band untouched", r.status === "NO_FILL" && !r.filled, r.status);
}
// EXPIRED: filled, then chops between SL and TP past the outcome window.
{
  const fwd = [c(60, 100, 100.1, 99.9, 100), ...Array.from({ length: 250 }, (_, i) => c((i + 2) * 60, 100.5, 100.8, 100.2, 100.5))];
  const r = simulateOutcome(sig, fwd, costs);
  ok("expired when neither level hit in window", r.status === "EXPIRED" && r.filled, `${r.status} R=${r.rMultiple.toFixed(2)}`);
}
// Costs reduce a winner's realized R below the gross target.
{
  const r = simulateOutcome(sig, [c(60, 100, 100.1, 99.9, 100), c(120, 101, 103.5, 100.5, 103)], costs);
  ok("costs deducted from realized R", r.rMultiple < 3 && r.rMultiple > 2.8, `R=${r.rMultiple.toFixed(3)}`);
}

console.log("\n── replay smoke ───────────────────────────────────────────");
{
  const rules = loadRules();
  const wl = loadWatchlist();
  const empty = { candles1m: [], candles15m: [], candles1h: [], funding: [], oi: [] };
  const trades = replaySymbol("BTCUSDT", empty, { rules, global: wl.global, minConfidence: 65, stepMin: 5, costs });
  ok("replaySymbol returns [] on insufficient data", Array.isArray(trades) && trades.length === 0, `${trades.length} trades`);

  // Synthetic, sufficient, flat-ish data: exercises the step loop, window slicing,
  // regime/trend/detector pipeline over hundreds of steps without throwing.
  const noise = (i: number, amp: number) => Math.sin(i / 7) * amp;
  const gen = (n: number, stepSec: number, amp: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const p = 100 + noise(i, amp);
      return c(i * stepSec, p, p + amp * 0.5, p - amp * 0.5, 100 + noise(i + 1, amp), 100);
    });
  const data = {
    candles1m: gen(500, 60, 0.05),
    candles15m: gen(220, 900, 0.3),
    candles1h: gen(80, 3600, 0.5),
    funding: Array.from({ length: 200 }, (_, i) => ({ time: i * 3600, fundingRate: (i % 5) * 1e-5 })),
    oi: Array.from({ length: 200 }, (_, i) => ({ time: i * 3600, openInterest: 1_000_000 + i * 100 })),
  };
  let threw = false;
  let trades2: unknown[] = [];
  try {
    trades2 = replaySymbol("BTCUSDT", data, { rules, global: wl.global, minConfidence: 65, stepMin: 5, costs });
  } catch (err) {
    threw = true;
    console.log(`  threw: ${(err as Error).message}`);
  }
  ok("replaySymbol runs the full step loop without throwing", !threw && Array.isArray(trades2), `${trades2.length} trades`);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
