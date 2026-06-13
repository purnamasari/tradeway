// SMC_SCALP — a faster, scalp-cadence sibling of the SMC strategy. It reuses
// the SAME proven detection core (detectSmcSetup in smc-core.ts) that powers
// the validated SMC plug-in, but with a scalp-tuned parameter set: a smaller
// displacement threshold, shorter liquidity/sweep windows, a market-style
// entry at the break (no deep retrace wait), a tighter stop, and a short
// TTL/hold. The net effect is many more, smaller, faster trades than SMC's
// ~0.5-1/month swing cadence.
//
// ⚠️ PARKED — backtest-only, NOT in the live engine.strategies list. A 90d × 5
// gate-funnel investigation found no real scalp edge at 15m: the market-at-break
// entry (entryStyle:1) gives dead RR (93% of full-confluence setups rejected at
// the RR gate), and 15m bars can't supply or time scalp structures. Full
// writeup + the B-vs-C decision: research/output/SMC_SCALP_findings.md.
//
// ⚠️ PARAMETERS ARE NOT YET VALIDATED. Unlike SMC_CANONICAL / H18_PARAMS (which
// passed a research round), SMC_SCALP_PARAMS below are an engineering starting
// point chosen by analogy, not by a probe/validation sweep. Treat live signals
// as EXPERIMENTAL until backtested:
//
//   pnpm backtest -- --strategy=SMC_SCALP --days=60 --step=5
//
// and a research round mirrors smc-core's design protocol (BTC+SOL probe, then
// out-of-sample validation on the rest). Until then this rides alongside the
// validated strategies but its edge is unproven.
//
// Exit plan (engine-enforced from the intent): fixed stop beyond the sweep
// wick / order block, fixed target at the nearest untapped opposing pool
// (≥1.2R, capped 2R), 1h entry TTL, 8h max hold. Breakeven hook dormant
// (beTriggerR = 0) — same convention as SMC.
import type { Regime } from "../types.js";
import type { Rules } from "../config.js";
import { classifyRegime } from "../regime/engine.js";
import { atrSeries } from "../indicators.js";
import { detectSmcSetupStaged, type SmcParams } from "./smc-core.js";
import type { Strategy, StrategyContext, EntryDecision, ExitDecision, PositionState } from "../engine/index.js";
import { entry, noEntry, hold } from "../engine/index.js";
import type { Position } from "../engine/index.js";

const H = 3_600_000;
const DAY_BARS = 96; // 15m bars per day

/** Scalp-tuned parameters. NOT validated — see file header. The deltas from
 *  SMC_CANONICAL are all in the "more, faster, smaller" direction:
 *    pivotK 3→2          more structure points ⇒ more setups
 *    liqLookback 192→96  1-day liquidity horizon (vs 2)
 *    sweepWindow 12→6    sweep must be within ~90m (vs 3h)
 *    minRR 1.5→1.2       take closer targets
 *    maxRR 3→2           scalp targets, not swings
 *    slBufAtr 0.25→0.2   tighter stop
 *    fvgMinAtr 0.75→0.35 allow smaller displacement ⇒ more setups (the
 *                        load-bearing knob — raise it to trade less, lower to
 *                        trade more)
 *    entryStyle 0→1      enter at the BOS close (±0.2·ATR15) instead of waiting
 *                        for a deep FVG retrace ⇒ fills far more often
 *    entryTtl 2h→1h      stale fast
 *    maxHold 48h→8h      scalp horizon */
export const SMC_SCALP_PARAMS: SmcParams = {
  pivotK: 2,
  liqLookbackBars: 96,
  sweepWindow: 6,
  minRR: 1.2,
  maxRR: 2,
  slBufAtr: 0.2,
  beTriggerR: 0,
  biasBars: 0,
  entryFrac: 1,
  fvgMinAtr: 0.35,
  entryStyle: 1, // market at the BOS close — the scalp enters the move, not a retrace
  entryTtlMs: 1 * H,
  maxHoldMs: 8 * H,
};

/** The regime gate still dominates the bar requirement (trailing-30d ATR
 *  percentile, research parity), exactly as SMC. */
export const SMC_SCALP_MIN_BARS = 30 * DAY_BARS + 1;

interface SmcScalpState extends PositionState {
  initialRisk: number;
}

export function createSmcScalpStrategy(regimeRules: Rules["regime"]): Strategy {
  const p = SMC_SCALP_PARAMS;
  return {
    id: "SMC_SCALP",
    label: "SMC Scalp",
    description: "15m liquidity sweep-reversal, scalp cadence (mins–hours, experimental)",
    minBars: SMC_SCALP_MIN_BARS,
    stages: ["data", "regime", "bias", "bos", "sweep", "fvg", "sanity", "rr"],

    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const c15 = ctx.candles15m;
      if (c15.length < SMC_SCALP_MIN_BARS) return noEntry(`needs ${SMC_SCALP_MIN_BARS} closed 15m bars`, "data");

      const i = c15.length - 1;
      const fullAtr = atrSeries(c15, regimeRules.atr_period);
      const atr15 = fullAtr[i]!;
      if (!Number.isFinite(atr15) || atr15 <= 0) return noEntry("ATR(15m) unavailable", "data");

      // Regime gate — identical to SMC: sweep-reversals are a range/volatility
      // phenomenon, flat-negative in trending/low_vol.
      const atrHist = fullAtr.slice(-30 * DAY_BARS).filter(Number.isFinite);
      const regime: Regime = classifyRegime(c15.slice(-320), regimeRules, atrHist).regime;
      if (regime !== "ranging" && regime !== "high_volatility") {
        return noEntry(`regime ${regime} — sweep-reversal entries need ranging/high_volatility`, "regime");
      }

      const res = detectSmcSetupStaged(c15, i, atr15, p);
      if (!res.ok) return noEntry(res.reason, res.stage);
      const setup = res.setup;

      const long = setup.direction === "long";
      const entryMid = (setup.zoneLow + setup.zoneHigh) / 2;
      const state: SmcScalpState = { initialRisk: Math.abs(entryMid - setup.sl) };
      return entry({
        strategyId: "SMC_SCALP",
        symbol: ctx.symbol,
        side: long ? "LONG" : "SHORT",
        entryZone: { low: setup.zoneLow, high: setup.zoneHigh },
        stopPrice: setup.sl,
        targetPrice: setup.tp,
        entryTtlMs: p.entryTtlMs,
        maxHoldMs: p.maxHoldMs,
        state,
        meta: {
          sweptLevel: setup.sweptLevel,
          sweepExtreme: setup.sweepExtreme,
          bosLevel: setup.bosLevel,
          obLevel: setup.obLevel,
          rr: setup.rr,
        },
        reasons: [
          `liquidity sweep: ${long ? "sell-side" : "buy-side"} pool ${setup.sweptLevel} raided (wick ${setup.sweepExtreme}) and reclaimed`,
          `break of structure: close ${ctx.price} ${long ? ">" : "<"} swing ${setup.bosLevel} (first close ${long ? "above" : "below"})`,
          `market entry at break (displacement FVG ${setup.zoneLow}–${setup.zoneHigh} as evidence)`,
          setup.obLevel != null
            ? `stop beyond order block / sweep wick at ${setup.sl}`
            : `stop beyond sweep wick at ${setup.sl}`,
          `target ${setup.tp} at opposing liquidity (${setup.rr.toFixed(1)}R)`,
          `regime ${regime} (sweep-reversal friendly)`,
        ],
      });
    },

    updateState(_ctx: StrategyContext, position: Position): PositionState {
      return position.state; // all exit knowledge is frozen at signal time
    },

    evaluateExit(ctx: StrategyContext, position: Position): ExitDecision {
      if (p.beTriggerR <= 0) return hold;
      const s = position.state as SmcScalpState;
      if (!Number.isFinite(s.initialRisk) || s.initialRisk <= 0) return hold;
      const progress =
        position.side === "LONG" ? ctx.price - position.entryPrice : position.entryPrice - ctx.price;
      if (progress < p.beTriggerR * s.initialRisk) return hold;
      return {
        action: "move_stop",
        stopPrice: position.entryPrice,
        reason: `breakeven (≥ ${p.beTriggerR}R close progress)`,
      };
    },
  };
}
