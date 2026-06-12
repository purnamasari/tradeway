// Risk engine — position sizing as a policy, fully separated from strategy
// logic. Strategies emit EntryIntents (signal + stop); a RiskEngine turns an
// intent into a size or a veto. The bot is currently advisory (read-only on
// the exchange), so sizes inform notifications and paper tracking — but the
// abstraction is execution-ready.
import type { AccountState, EntryIntent, RiskDecision } from "./types.js";

export interface RiskEngine {
  id: string;
  size(intent: EntryIntent, account: AccountState): RiskDecision;
}

export interface RiskLimits {
  /** Veto when this many positions are already open. */
  maxOpenPositions?: number;
  /** Veto when open risk (fraction of equity) already meets/exceeds this. */
  maxOpenRiskFraction?: number;
}

const veto = (model: string, reason: string): RiskDecision => ({
  approved: false,
  qty: 0,
  riskAmount: 0,
  model,
  reasons: [reason],
});

function checkLimits(model: string, account: AccountState, limits: RiskLimits): RiskDecision | null {
  if (limits.maxOpenPositions != null && account.openPositions >= limits.maxOpenPositions) {
    return veto(model, `max open positions reached (${account.openPositions}/${limits.maxOpenPositions})`);
  }
  if (limits.maxOpenRiskFraction != null && account.openRiskFraction >= limits.maxOpenRiskFraction) {
    return veto(model, `max open risk reached (${(account.openRiskFraction * 100).toFixed(1)}%)`);
  }
  return null;
}

/** Entry reference and stop distance shared by all models. */
function stopGeometry(intent: EntryIntent): { entry: number; stopDist: number } | null {
  const entry = (intent.entryZone.low + intent.entryZone.high) / 2;
  const stopDist = Math.abs(entry - intent.stopPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(stopDist) || entry <= 0 || stopDist <= 0) return null;
  return { entry, stopDist };
}

/**
 * Fixed fractional risk: risk `fraction` of equity per trade; size = risk ÷
 * stop distance. The classic 1R model — paired with ATR-based stops it is
 * already volatility-aware.
 */
export function fixedFractionRisk(fraction: number, limits: RiskLimits = {}): RiskEngine {
  const id = `fixed_fraction_${fraction}`;
  return {
    id,
    size(intent, account) {
      const limited = checkLimits(id, account, limits);
      if (limited) return limited;
      const g = stopGeometry(intent);
      if (!g) return veto(id, "invalid entry/stop geometry");
      const riskAmount = account.equity * fraction;
      const qty = riskAmount / g.stopDist;
      return {
        approved: true,
        qty,
        riskAmount,
        model: id,
        reasons: [`risk ${(fraction * 100).toFixed(2)}% of equity = ${riskAmount.toFixed(2)} over ${g.stopDist} stop distance`],
      };
    },
  };
}

/** Fixed notional: always deploy the same quote amount; risk varies with the stop. */
export function fixedNotional(notional: number, limits: RiskLimits = {}): RiskEngine {
  const id = `fixed_notional_${notional}`;
  return {
    id,
    size(intent, account) {
      const limited = checkLimits(id, account, limits);
      if (limited) return limited;
      const g = stopGeometry(intent);
      if (!g) return veto(id, "invalid entry/stop geometry");
      const qty = notional / g.entry;
      return {
        approved: true,
        qty,
        riskAmount: qty * g.stopDist,
        model: id,
        reasons: [`fixed notional ${notional} at ${g.entry}`],
      };
    },
  };
}

/**
 * Volatility targeting: size so the position contributes `targetDailyVol`
 * (fraction of equity per day) given the intent's realized-volatility
 * estimate. Vetoes when the strategy provided no volatility figure rather
 * than guessing.
 */
export function volatilityTarget(targetDailyVol: number, limits: RiskLimits = {}): RiskEngine {
  const id = `vol_target_${targetDailyVol}`;
  return {
    id,
    size(intent, account) {
      const limited = checkLimits(id, account, limits);
      if (limited) return limited;
      const g = stopGeometry(intent);
      if (!g) return veto(id, "invalid entry/stop geometry");
      const vol = intent.volatility;
      if (vol == null || !Number.isFinite(vol) || vol <= 0) {
        return veto(id, "intent carries no volatility estimate");
      }
      const notional = (account.equity * targetDailyVol) / vol;
      const qty = notional / g.entry;
      return {
        approved: true,
        qty,
        riskAmount: qty * g.stopDist,
        model: id,
        reasons: [`target ${(targetDailyVol * 100).toFixed(2)}%/day over realized ${(vol * 100).toFixed(2)}%/day`],
      };
    },
  };
}

/**
 * Advisory mode: approves with qty 0 — for the current alert-only bot, where
 * a size would imply an execution that never happens. Notifications render
 * the stop distance and let the trader size manually.
 */
export function advisoryOnly(): RiskEngine {
  return {
    id: "advisory",
    size: () => ({ approved: true, qty: 0, riskAmount: 0, model: "advisory", reasons: ["alert-only mode — no sizing"] }),
  };
}
