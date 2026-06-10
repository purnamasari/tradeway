// Management-plan generator — turns a freshly gated Signal into a conditional
// exit plan (Base / Protection / Aggressive / Emergency) the trader can follow
// without the bot. The same triggers are evaluated live by the manager once the
// trade fills, so the plan is a contract, not just prose.
import type { Regime, Signal, ManagementPlan, StopMethod } from "../types.js";
import type { Rules } from "../config.js";

const TRAIL_BY_REGIME: Record<Regime, StopMethod> = {
  trending: "swing",
  high_volatility: "atr",
  ranging: "structure",
  low_volatility: "ema",
};

const TRAIL_LABEL: Record<StopMethod, string> = {
  swing: "swing-low/high trailing",
  atr: "ATR trailing",
  ema: "EMA trailing",
  structure: "market-structure trailing",
};

export function buildManagementPlan(signal: Signal, rules: Rules): ManagementPlan {
  const m = rules.management;
  const entry = (signal.entry_low + signal.entry_high) / 2;
  const risk = Math.abs(entry - signal.sl);
  const sign = signal.direction === "long" ? 1 : -1;
  const lockPct = Math.round(m.lock_fraction * 100);
  const resistPct = Math.round(m.resistance_partial_fraction * 100);
  const levelWord = signal.direction === "long" ? "resistance" : "support";
  const breakWord = signal.direction === "long" ? "below" : "above";
  const againstPattern = signal.direction === "long" ? "bearish engulfing" : "bullish engulfing";
  const trail = TRAIL_BY_REGIME[signal.regime];

  const atR = (r: number) => fmt(entry + sign * risk * r);

  return {
    base: {
      entry_low: signal.entry_low,
      entry_high: signal.entry_high,
      sl: signal.sl,
      tp: signal.tp,
    },
    protection: [
      {
        trigger: `price reaches +${m.breakeven_at_r}R (${atR(m.breakeven_at_r)})`,
        action: `move SL to breakeven (${fmt(entry)})`,
      },
      {
        trigger: `price reaches +${m.lock_at_r}R (${atR(m.lock_at_r)})`,
        action: `take ${lockPct}% partial profit`,
      },
      {
        trigger: `volume weakens near ${levelWord}`,
        action: `take ${resistPct}% partial, tighten stop`,
      },
    ],
    aggressive: [
      {
        trigger: `price runs past +2R (${atR(2)}) on strong volume`,
        action: `hold the runner for TP ${fmt(signal.tp)}, trail with ${TRAIL_LABEL[trail]}`,
      },
    ],
    emergency: [
      {
        trigger: `${againstPattern} on high volume`,
        action: "exit 75%",
      },
      {
        trigger: `structure breaks (15m close ${breakWord} ${fmt(signal.sl)} zone / protective level)`,
        action: "exit immediately",
      },
      {
        trigger: `live confidence drops below ${m.emergency_confidence_floor}`,
        action: "exit immediately",
      },
    ],
    trail_method: trail,
  };
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
  return Number(n.toFixed(dp)).toString();
}
