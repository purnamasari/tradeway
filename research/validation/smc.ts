// SMC as a parameterized strategy for the validation framework. The detection
// logic lives in src/strategies/smc-core.ts and is SHARED with the production
// plug-in — research and production run the same code path by construction.
// SMC_CANONICAL (smc-core.ts) is the frozen parameter set; the sweep runs
// neighboring values to MEASURE robustness, never to re-tune.
import {
  computePivots,
  detectSmcSetup,
  SMC_CANONICAL,
  type PivotFlags,
  type SmcParams,
} from "../../src/strategies/smc-core.js";
import type { FastContext } from "./fast-context.js";
import type { Strategy, StratSignal } from "./strategy.js";

/** Global pivot flags, memoized per (context, pivotK) so sweep variants share
 *  them. Lookahead-safe: detectSmcSetup only consumes pivots whose right side
 *  has closed by the decision bar (see smc-core.ts). */
function pivots(ctx: FastContext, k: number): PivotFlags {
  const key = `smc-pivots:${k}`;
  const hit = ctx.cache.get(key) as PivotFlags | undefined;
  if (hit) return hit;
  const flags = computePivots(ctx.candles, k);
  ctx.cache.set(key, flags);
  return flags;
}

export function smcStrategy(p: SmcParams = SMC_CANONICAL): Strategy {
  return {
    name: "SMC",
    params: p as unknown as Record<string, number>,
    minBars: p.liqLookbackBars + 2 * p.pivotK + 2,
    signalAt(ctx: FastContext, i: number): StratSignal | null {
      // Regime gate — sweep-reversals are a range/volatility phenomenon:
      // round-6 analytics showed the edge lives in ranging (+0.35) and
      // high_volatility (+0.32) and is flat-negative in trending/low_vol.
      // The complement of H18's gate (which skips ranging).
      const regime = ctx.regime[i]!;
      if (regime !== "ranging" && regime !== "high_volatility") return null;
      const atr15 = ctx.atr15[i]!;
      if (!Number.isFinite(atr15) || atr15 <= 0) return null;
      const setup = detectSmcSetup(ctx.candles, i, atr15, p, pivots(ctx, p.pivotK));
      if (!setup) return null;
      return {
        direction: setup.direction,
        entry_low: setup.zoneLow,
        entry_high: setup.zoneHigh,
        sl: setup.sl,
        tp: setup.tp,
        be_trigger_r: p.beTriggerR,
        trail_dist: Infinity, // managed exits: fixed TP + breakeven, no trail
        entry_ttl_ms: p.entryTtlMs,
        outcome_ttl_ms: p.maxHoldMs,
      };
    },
  };
}
