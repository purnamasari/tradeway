// Exit engine — executes exit primitives and standing exits with zero
// strategy knowledge. Supports, without core changes:
//   fixed stop        (Position.stopPrice, set at entry)
//   fixed take-profit (Position.targetPrice, optional)
//   trailing stop     (strategy returns move_stop; ratchet-only enforced here)
//   time stop         (entryDeadline / maxHoldUntil / bar age via strategy)
//   strategy exit     (strategy returns exit with its own reason)
//
// Evaluation order on each bar (pessimistic, mirrors the research simulator):
//   1. standing stop breach        → EXITED_STOP
//   2. standing target touch       → EXITED_TARGET
//   3. deadlines (entry / max hold)→ CANCELLED / EXITED_TIME
//   4. strategy decision           → exit / move_stop / set_target / hold
import type { Candle } from "../types.js";
import type { ExitDecision } from "./types.js";
import { fillPosition, type Position } from "./position.js";

/** What the engine did to a position on one evaluation pass. */
export interface PositionTransition {
  position: Position;
  /** Events worth notifying/logging, in occurrence order. */
  events: TransitionEvent[];
}

export type TransitionEvent =
  | { kind: "filled"; price: number }
  | { kind: "stop_moved"; from: number; to: number; reason: string }
  | { kind: "target_changed"; from: number | null; to: number | null; reason: string }
  | { kind: "closed"; status: Position["status"]; price: number; reason: string };

const close = (
  p: Position,
  status: Position["status"],
  price: number,
  reason: string,
  atMs: number,
): PositionTransition => ({
  position: { ...p, status, exitPrice: price, exitReason: reason, closedAt: atMs },
  events: [{ kind: "closed", status, price, reason }],
});

/**
 * Standing-exit pass for one closed bar. Pure. Handles PENDING_ENTRY fills
 * and OPEN stop/target/deadline exits, checking the stop BEFORE the target
 * when one bar spans both (pessimistic, same as the validated simulator).
 * `bar` must be CLOSED; `nowMs` is its close time in ms.
 */
export function evaluateBar(p: Position, bar: Candle, nowMs: number): PositionTransition {
  if (p.status === "PENDING_ENTRY") {
    // Eligibility matches the research simulator: a bar may fill iff its OPEN
    // is at/inside the entry window. A bar opening past the deadline (e.g.
    // after a restart gap) cancels without a touch check.
    if (bar.time * 1000 > p.entryDeadline) {
      return close(p, "CANCELLED", bar.close, "entry window expired", nowMs);
    }
    const touched = bar.low <= p.entryZone.high && bar.high >= p.entryZone.low;
    if (touched) {
      // Fill, then immediately enforce the stop on the same bar (pessimistic).
      const fillPrice = p.entryPrice; // zone mid — same convention as research sim
      const filled = fillPosition(p, fillPrice, nowMs);
      const after = evaluateOpenBar(filled, bar, nowMs);
      return { position: after.position, events: [{ kind: "filled", price: fillPrice }, ...after.events] };
    }
    // Strict: the NEXT bar opens at nowMs and is still eligible when
    // nowMs == deadline (research: `c.time > entryDeadline` breaks).
    if (nowMs > p.entryDeadline) {
      return close(p, "CANCELLED", bar.close, "entry window expired", nowMs);
    }
    return { position: p, events: [] };
  }

  if (p.status === "OPEN") return evaluateOpenBar(p, bar, nowMs);
  return { position: p, events: [] };
}

function evaluateOpenBar(p: Position, bar: Candle, nowMs: number): PositionTransition {
  const isLong = p.side === "LONG";
  const hitStop = isLong ? bar.low <= p.stopPrice : bar.high >= p.stopPrice;
  if (hitStop) return close(p, "EXITED_STOP", p.stopPrice, "stop hit", nowMs);

  if (p.targetPrice != null) {
    const hitTarget = isLong ? bar.high >= p.targetPrice : bar.low <= p.targetPrice;
    if (hitTarget) return close(p, "EXITED_TARGET", p.targetPrice, "target hit", nowMs);
  }

  if (p.maxHoldUntil != null && nowMs >= p.maxHoldUntil) {
    return close(p, "EXITED_TIME", bar.close, "max hold reached", nowMs);
  }

  return { position: { ...p, ageBars: p.ageBars + 1 }, events: [] };
}

/**
 * Apply a strategy's ExitDecision to an OPEN position. Pure.
 * move_stop is RATCHET-ONLY: a long's stop never moves down, a short's never
 * up — a strategy bug cannot widen risk through this path.
 */
export function applyExitDecision(
  p: Position,
  decision: ExitDecision,
  price: number,
  nowMs: number,
): PositionTransition {
  if (p.status !== "OPEN" || decision.action === "hold") return { position: p, events: [] };

  switch (decision.action) {
    case "exit":
      return close(p, "EXITED_STRATEGY", price, decision.reason, nowMs);

    case "move_stop": {
      const isLong = p.side === "LONG";
      const tightens = isLong ? decision.stopPrice > p.stopPrice : decision.stopPrice < p.stopPrice;
      if (!tightens || !Number.isFinite(decision.stopPrice)) return { position: p, events: [] };
      return {
        position: { ...p, stopPrice: decision.stopPrice },
        events: [{ kind: "stop_moved", from: p.stopPrice, to: decision.stopPrice, reason: decision.reason }],
      };
    }

    case "set_target": {
      if (decision.targetPrice === p.targetPrice) return { position: p, events: [] };
      return {
        position: { ...p, targetPrice: decision.targetPrice },
        events: [
          { kind: "target_changed", from: p.targetPrice, to: decision.targetPrice, reason: decision.reason },
        ],
      };
    }
  }
}

/**
 * Between-bar safety check against a price tick: enforces ONLY the standing
 * stop/target so a fast move is not held hostage to the 15m cadence. No
 * strategy code runs here. Pure.
 */
export function evaluateTick(p: Position, price: number, nowMs: number): PositionTransition {
  if (p.status !== "OPEN") return { position: p, events: [] };
  const isLong = p.side === "LONG";
  if (isLong ? price <= p.stopPrice : price >= p.stopPrice) {
    return close(p, "EXITED_STOP", p.stopPrice, "stop hit (tick)", nowMs);
  }
  if (p.targetPrice != null && (isLong ? price >= p.targetPrice : price <= p.targetPrice)) {
    return close(p, "EXITED_TARGET", p.targetPrice, "target hit (tick)", nowMs);
  }
  return { position: p, events: [] };
}
