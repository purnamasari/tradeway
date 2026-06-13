// Offline checks for the backtest fill model + a replay smoke test. No network.
//   pnpm test:backtest
import { simulateOutcome, type SimSignal } from "./backtest/simulate.js";
import { replaySymbol, replayPluginSymbol } from "./backtest/engine.js";
import { entry, noEntry, hold, type Strategy } from "./engine/index.js";
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

console.log("\n── 1m intrabar resolution (plugin path) ──────────────────");
{
  const rules = loadRules();
  const wl = loadWatchlist();

  // A strategy that fires exactly one LONG with a fixed zone/stop/target, so
  // the OUTCOME is decided entirely by the injected 1m window.
  const fixedEntry = (ttlMs: number): Strategy => {
    let fired = false;
    return {
      id: "TEST",
      minBars: 1,
      evaluateEntry(ctx) {
        if (fired) return noEntry("once", "data");
        fired = true;
        return entry({
          strategyId: "TEST",
          symbol: ctx.symbol,
          side: "LONG",
          entryZone: { low: 99.9, high: 100.1 },
          stopPrice: 99,
          targetPrice: 102,
          entryTtlMs: ttlMs,
          maxHoldMs: 8 * 3_600_000,
          reasons: [],
        });
      },
      updateState: (_c, p) => p.state,
      evaluateExit: () => hold,
    };
  };

  // Entry fires at 15m bar index 2880; it resolves over bar 2881's window
  // [2592900, 2593800). Inject 1m bars there to drive the outcome.
  const W = 2881 * 900;
  const base15 = Array.from({ length: 2890 }, (_, k) => {
    const p = 100 + Math.sin(k / 9) * 0.4;
    return c(k * 900, p, p + 0.3, p - 0.3, p);
  });
  const base1h = Array.from({ length: 200 }, (_, k) => {
    const p = 100 + Math.sin(k / 5) * 0.5;
    return c(k * 3600, p, p + 0.4, p - 0.4, p);
  });
  // 1m bar at minute offset `off`: o=cl=`oc`, custom high/low.
  const m1 = (off: number, oc: number, h: number, l: number) => c(W + off * 60, oc, h, l, oc);
  const run = (c1m: Candle[], ttlMs = 2 * 3_600_000) =>
    replayPluginSymbol(
      "T",
      { candles1m: c1m, candles15m: base15, candles1h: base1h, funding: [], oi: [] },
      fixedEntry(ttlMs),
      { rules, global: wl.global, minConfidence: 0, stepMin: 5, costs },
    );

  // TP: fill on bar 0, target (102) tagged on bar 1.
  {
    const t = run([m1(0, 100, 100.1, 99.95), m1(1, 101, 102.5, 101)]);
    ok("1m: fill then TP", t.length === 1 && t[0]!.status === "TP" && t[0]!.filled, `${t[0]?.status}`);
  }
  // SL: fill on bar 0, stop (99) tagged on bar 1.
  {
    const t = run([m1(0, 100, 100.1, 99.95), m1(1, 99.5, 99.6, 98.5)]);
    ok("1m: fill then SL", t.length === 1 && t[0]!.status === "SL" && t[0]!.filled, `${t[0]?.status}`);
  }
  // SL-first: a single 1m bar spans both stop and target → SL (pessimistic).
  {
    const t = run([m1(0, 100, 100.1, 99.95), m1(1, 100, 102.5, 98.5)]);
    ok("1m: ambiguous bar → SL-first", t.length === 1 && t[0]!.status === "SL", `${t[0]?.status}`);
  }
  // NO_FILL: price stays away from the zone until the (short) entry TTL lapses.
  {
    const away = Array.from({ length: 6 }, (_, k) => m1(k, 105, 105.2, 104.8));
    const t = run(away, 120_000); // 2-min TTL — cancels mid-window
    ok("1m: untouched zone → NO_FILL", t.length === 1 && t[0]!.status === "NO_FILL" && !t[0]!.filled, `${t[0]?.status}`);
  }
  // Same-bar fill+TP resolves at 1m (not deferred to a 15m close).
  {
    const t = run([m1(0, 100, 102.5, 99.95)]);
    ok("1m: fill+TP same bar", t.length === 1 && t[0]!.status === "TP" && t[0]!.filled, `${t[0]?.status}`);
  }
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
