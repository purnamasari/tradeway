// Generic parameterized-strategy runner. A strategy decides at bar close from
// the FastContext only (indices <= i — anything later is future data); fills
// and exits go through the trailing simulator with ZERO costs, storing gross
// R + riskPct so any fee assumption can be applied afterwards.
import { simulateTrailing } from "../trailing-sim.js";
import type { FastContext } from "./fast-context.js";
import { WARMUP_BARS } from "./fast-context.js";
import type { ValTrade } from "./metrics.js";

const NO_COSTS = { feePct: 0, slippagePct: 0 };

export interface StratSignal {
  direction: "long" | "short";
  entry_low: number;
  entry_high: number;
  sl: number;
  trail_dist: number;
  entry_ttl_ms: number;
  outcome_ttl_ms: number;
}

export interface Strategy {
  name: string;
  params: Record<string, number>;
  /** Bars of history required before the first decision. */
  minBars: number;
  /** Decision at the close of bar i; may read ctx arrays only up to index i. */
  signalAt(ctx: FastContext, i: number): StratSignal | null;
}

export interface RunBounds {
  /** Only take signals whose decision-bar close is within [fromSec, toSec). */
  fromSec?: number;
  toSec?: number;
}

/** One open trade per symbol; identical slot semantics to the harness. */
export function runStrategy(ctx: FastContext, strat: Strategy, bounds: RunBounds = {}): ValTrade[] {
  const c = ctx.candles;
  const trades: ValTrade[] = [];
  let openUntil = 0;
  const start = Math.max(WARMUP_BARS, strat.minBars);
  for (let i = start; i < c.length; i++) {
    const closeTime = c[i]!.time + 900;
    if (bounds.fromSec && closeTime < bounds.fromSec) continue;
    if (bounds.toSec && closeTime >= bounds.toSec) break;
    if (closeTime <= openUntil) continue;
    const sig = strat.signalAt(ctx, i);
    if (!sig) continue;

    const fwdBars = Math.ceil((sig.entry_ttl_ms + sig.outcome_ttl_ms) / 900_000) + 4;
    const sim = simulateTrailing(
      { ...sig, detected_at: closeTime * 1000 },
      c.slice(i + 1, i + 1 + fwdBars),
      NO_COSTS,
    );
    openUntil = sim.closedAt ?? closeTime + sig.entry_ttl_ms / 1000;
    if (!sim.filled) continue;

    const entryMid = (sig.entry_low + sig.entry_high) / 2;
    const risk = Math.abs(entryMid - sig.sl) || 1e-9;
    trades.push({
      symbol: ctx.symbol,
      direction: sig.direction,
      detectedAt: closeTime * 1000,
      month: new Date(closeTime * 1000).toISOString().slice(0, 7),
      regime: ctx.regime[i]!,
      status: sim.status,
      grossR: sim.grossR,
      riskPct: (risk / entryMid) * 100,
      durationMs: sim.durationMs,
    });
  }
  return trades;
}

export function runStrategyAll(ctxs: FastContext[], strat: Strategy, bounds: RunBounds = {}): ValTrade[] {
  return ctxs.flatMap((ctx) => runStrategy(ctx, strat, bounds));
}
