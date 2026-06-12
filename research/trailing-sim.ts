// Trailing-exit simulation for research hypotheses. Same conventions as
// src/backtest/simulate.ts (fill on entry-band touch, pessimistic intra-bar
// ordering, taker costs deducted from R), but the exit is a chandelier trail
// (extreme close since entry ∓ trailAtr) plus a fixed initial SL, no TP.
import type { Candle, Direction } from "../src/types.js";
import type { SimCosts } from "../src/backtest/simulate.js";

export interface TrailSignal {
  direction: Direction;
  entry_low: number;
  entry_high: number;
  sl: number; // initial hard stop
  trail_dist: number; // chandelier distance in price units
  detected_at: number; // unix ms
  entry_ttl_ms: number;
  outcome_ttl_ms: number;
}

export interface TrailResult {
  status: "SL" | "TRAIL" | "EXPIRED" | "NO_FILL";
  filled: boolean;
  rMultiple: number; // net of costs
  grossR: number;
  costR: number;
  closedAt: number | null; // unix sec
  durationMs: number | null;
}

export function simulateTrailing(sig: TrailSignal, forward: Candle[], costs: SimCosts): TrailResult {
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
  const mk = (status: TrailResult["status"], exit: number, at: number): TrailResult => {
    const grossR = (isLong ? exit - entryMid : entryMid - exit) / risk;
    return { status, filled: true, rMultiple: grossR - costR, grossR, costR, closedAt: at, durationMs: (at - enteredAt) * 1000 };
  };

  // Trail anchors to the extreme CLOSE since entry (conservative vs. high/low)
  // and only ratchets toward the trade.
  let anchor = forward[entryIdx]!.close;
  let stop = sig.sl;
  for (let i = entryIdx; i < forward.length; i++) {
    const c = forward[i]!;
    if (c.time > closeDeadline) return mk("EXPIRED", forward[Math.max(entryIdx, i - 1)]!.close, forward[Math.max(entryIdx, i - 1)]!.time);
    // Pessimistic ordering: stop checked against this bar BEFORE the anchor
    // ratchets on this bar's close.
    if (isLong ? c.low <= stop : c.high >= stop) return mk(stop === sig.sl ? "SL" : "TRAIL", stop, c.time);
    anchor = isLong ? Math.max(anchor, c.close) : Math.min(anchor, c.close);
    const trail = isLong ? anchor - sig.trail_dist : anchor + sig.trail_dist;
    stop = isLong ? Math.max(stop, trail) : Math.min(stop, trail);
  }
  const last = forward[forward.length - 1]!;
  return mk("EXPIRED", last.close, last.time);
}
