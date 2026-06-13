// SMC — smart-money-concepts strategy plug-in (liquidity sweep → break of
// structure → fair-value-gap retrace entry, order-block-refined stop).
// Detection lives in smc-core.ts and is SHARED with the research reference
// (research/validation/smc.ts), so entry decisions are identical by
// construction; validated by research/validation/replay-smc.ts and reported
// in research/output/SMC_validation.md.
//
// PARAMETERS ARE FROZEN (SMC_CANONICAL in smc-core.ts). Any change
// invalidates the validation and requires a new research round.
//
// Exit plan (the engine enforces all of it from the intent):
//   stop   : beyond min(sweep wick, order block) − 0.25·ATR15 (fixed)
//   target : nearest untapped opposing liquidity pool (≥1.5R, capped 3R;
//            2R default when no pool is in range)
//   horizon: 2h entry TTL, 48h max hold
//   no breakeven move, no trail — both measured harmful in design
//   (probe-smc.ts round 2); evaluateExit keeps the breakeven hook for a
//   future re-validated parameter set (dormant at beTriggerR = 0).
//
// Frequency: ~0.5-1 signal/month/symbol — a daytrader cadence (hours-to-2-day
// holds) complementing H18's multi-day trend positions. Both can hold the
// same symbol independently: slots are keyed (symbol, strategyId).
import type { Regime } from "../types.js";
import type { Rules } from "../config.js";
import { classifyRegime } from "../regime/engine.js";
import { atrSeries } from "../indicators.js";
import { detectSmcSetupStaged, SMC_CANONICAL } from "./smc-core.js";
import type { Strategy, StrategyContext, EntryDecision, ExitDecision, PositionState } from "../engine/index.js";
import { entry, noEntry, hold } from "../engine/index.js";
import type { Position } from "../engine/index.js";

const DAY_BARS = 96; // 15m bars per day

/** Closed 15m bars a decision needs. The regime gate dominates: its ATR
 *  percentile wants a trailing 30d window (research parity), far more than
 *  the liquidity lookback needs. */
export const SMC_MIN_BARS = 30 * DAY_BARS + 1;
/** Provider depth to request: minBars + regime/ATR convergence headroom. */
export const SMC_CONTEXT_BARS = SMC_MIN_BARS + 511;

interface SmcState extends PositionState {
  /** |entry zone mid − initial stop|, frozen at signal time (for the dormant
   *  breakeven hook; the engine fills at the zone mid, same convention). */
  initialRisk: number;
}

export function createSmcStrategy(regimeRules: Rules["regime"]): Strategy {
  const p = SMC_CANONICAL;
  return {
    id: "SMC",
    label: "SMC",
    description: "15m liquidity sweep-reversal, daytrader cadence (hours–2 days)",
    minBars: SMC_MIN_BARS,
    stages: ["data", "regime", "bias", "bos", "sweep", "fvg", "sanity", "rr"],

    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const c15 = ctx.candles15m;
      if (c15.length < SMC_MIN_BARS) return noEntry(`needs ${SMC_MIN_BARS} closed 15m bars`, "data");

      const i = c15.length - 1;
      const fullAtr = atrSeries(c15, regimeRules.atr_period);
      const atr15 = fullAtr[i]!;
      if (!Number.isFinite(atr15) || atr15 <= 0) return noEntry("ATR(15m) unavailable", "data");

      // Regime gate — research-identical inputs (window 320, trailing-30d ATR
      // percentile), same construction as the H18 plug-in. Sweep-reversals
      // are a range/volatility phenomenon: validation showed the edge lives
      // in ranging/high_volatility and is flat-negative in trending/low_vol
      // (the complement of H18's skip-ranging gate).
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
      const state: SmcState = { initialRisk: Math.abs(entryMid - setup.sl) };
      return entry({
        strategyId: "SMC",
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
          `displacement FVG entry zone ${setup.zoneLow}–${setup.zoneHigh} (≥ ${p.fvgMinAtr}·ATR15)`,
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
      // Dormant at the canonical beTriggerR = 0: standing stop/target/time
      // exits are engine-enforced; nothing to manage bar-to-bar.
      if (p.beTriggerR <= 0) return hold;
      const s = position.state as SmcState;
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
