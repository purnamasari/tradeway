// Managed-exit simulation for target-based strategies (SMC and similar):
// fixed initial SL, fixed TP, breakeven stop-move at a configurable R trigger
// (decided at bar CLOSE, matching the engine's move_stop cadence), optional
// chandelier trail, outcome TTL. Same conventions as trailing-sim.ts (fill on
// entry-band touch at zone mid, pessimistic intra-bar ordering: stop before
// target, both before any close-based stop management on the same bar) so
// results are comparable across simulators and reproducible by the engine
// (src/engine/exit.ts checks stop → target → deadlines in that order too).
import type { Candle, Direction } from "../../src/types.js";
import type { SimCosts } from "../../src/backtest/simulate.js";

export interface ManagedSignal {
  direction: Direction;
  entry_low: number;
  entry_high: number;
  sl: number; // initial hard stop
  tp: number; // fixed take-profit
  /** Move the stop to entry once close-progress ≥ this many R (0 = disabled). */
  be_trigger_r: number;
  /** Chandelier trail distance in price units; Infinity/0 = no trail. */
  trail_dist: number;
  detected_at: number; // unix ms
  entry_ttl_ms: number;
  outcome_ttl_ms: number;
}

export interface ManagedResult {
  status: "SL" | "BE" | "TP" | "TRAIL" | "EXPIRED" | "NO_FILL";
  filled: boolean;
  rMultiple: number; // net of costs
  grossR: number;
  costR: number;
  closedAt: number | null; // unix sec
  durationMs: number | null;
}

export function simulateManaged(sig: ManagedSignal, forward: Candle[], costs: SimCosts): ManagedResult {
  const isLong = sig.direction === "long";
  const entryMid = (sig.entry_low + sig.entry_high) / 2;
  const tSec = Math.floor(sig.detected_at / 1000);
  const entryDeadline = tSec + sig.entry_ttl_ms / 1000;
  const risk = Math.abs(entryMid - sig.sl) || 1e-9;
  const costR = (entryMid * ((costs.feePct + 2 * costs.slippagePct) / 100)) / risk;

  let entryIdx = -1;
  for (let i = 0; i < forward.length; i++) {
    const c = forward[i]!;
    if (c.time > entryDeadline) break;
    if (c.low <= sig.entry_high && c.high >= sig.entry_low) { entryIdx = i; break; }
  }
  if (entryIdx === -1) {
    return { status: "NO_FILL", filled: false, rMultiple: 0, grossR: 0, costR: 0, closedAt: null, durationMs: null };
  }

  const enteredAt = forward[entryIdx]!.time;
  const closeDeadline = enteredAt + sig.outcome_ttl_ms / 1000;
  const mk = (status: ManagedResult["status"], exit: number, at: number): ManagedResult => {
    const grossR = (isLong ? exit - entryMid : entryMid - exit) / risk;
    return { status, filled: true, rMultiple: grossR - costR, grossR, costR, closedAt: at, durationMs: (at - enteredAt) * 1000 };
  };

  const hasTrail = Number.isFinite(sig.trail_dist) && sig.trail_dist > 0;
  const beTarget = isLong ? entryMid + sig.be_trigger_r * risk : entryMid - sig.be_trigger_r * risk;
  let anchor = forward[entryIdx]!.close;
  let stop = sig.sl;
  let stopKind: "SL" | "BE" | "TRAIL" = "SL";

  for (let i = entryIdx; i < forward.length; i++) {
    const c = forward[i]!;
    if (c.time > closeDeadline) return mk("EXPIRED", forward[Math.max(entryIdx, i - 1)]!.close, forward[Math.max(entryIdx, i - 1)]!.time);
    // Pessimistic intra-bar ordering: stop before target, both before any
    // close-based stop management on this bar (mirrors src/engine/exit.ts).
    if (isLong ? c.low <= stop : c.high >= stop) return mk(stopKind, stop, c.time);
    if (isLong ? c.high >= sig.tp : c.low <= sig.tp) return mk("TP", sig.tp, c.time);
    // Close-based management, ratchet-only (the engine enforces the same).
    if (sig.be_trigger_r > 0 && (isLong ? c.close >= beTarget : c.close <= beTarget)) {
      if (isLong ? entryMid > stop : entryMid < stop) { stop = entryMid; stopKind = "BE"; }
    }
    if (hasTrail) {
      anchor = isLong ? Math.max(anchor, c.close) : Math.min(anchor, c.close);
      const trail = isLong ? anchor - sig.trail_dist : anchor + sig.trail_dist;
      if (isLong ? trail > stop : trail < stop) { stop = trail; stopKind = "TRAIL"; }
    }
  }
  const last = forward[forward.length - 1]!;
  return mk("EXPIRED", last.close, last.time);
}
