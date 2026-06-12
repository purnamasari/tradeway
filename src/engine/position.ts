// Reusable position model + store abstraction. The position engine is the
// ONLY writer of position records; strategies receive read-only snapshots and
// influence them solely through ExitDecision primitives and PositionState.
import type { EntryIntent, PositionState, RiskDecision, Side } from "./types.js";

/**
 * PENDING_ENTRY — intent accepted, waiting for the entry zone to fill.
 * OPEN         — filled; stop/target/time/strategy exits armed.
 * Terminal states record WHY the position ended (analytics groups on this).
 */
export type PositionStatus =
  | "PENDING_ENTRY"
  | "OPEN"
  | "EXITED_STOP"
  | "EXITED_TARGET"
  | "EXITED_TIME"
  | "EXITED_STRATEGY"
  | "CANCELLED"; // entry deadline passed without a fill

export interface Position {
  id: string;
  strategyId: string;
  symbol: string;
  side: Side;

  entryZone: { low: number; high: number };
  /** Mid of the entry zone until filled; actual fill reference afterwards. */
  entryPrice: number;
  /** MUTABLE protective stop — trailing strategies ratchet it via move_stop. */
  stopPrice: number;
  /** Optional fixed target; null = none (trail/time/strategy exits only). */
  targetPrice: number | null;

  /** Sized by the risk engine; 0 in advisory (alert-only) mode. */
  qty: number;
  riskAmount: number;
  riskModel: string;

  openedAt: number; // unix ms — intent accepted
  filledAt: number | null; // unix ms — entry zone touched
  closedAt: number | null;
  /** Closed bars since fill (engine-incremented). Enables bar-based time stops. */
  ageBars: number;

  /** Entry must fill by this time (ms) or the position is CANCELLED. */
  entryDeadline: number;
  /** Strategy's holding horizon (ms from fill); null = no time stop. */
  maxHoldMs: number | null;
  /** Absolute hard time stop, armed at fill (filledAt + maxHoldMs). */
  maxHoldUntil: number | null;

  status: PositionStatus;
  exitPrice: number | null;
  exitReason: string | null;

  /** Strategy-specific memory, persisted opaquely (JSONB).
   *  e.g. H18: { highestClose } · SMC: { sweepLevel } */
  state: PositionState;

  /** Strategy-authored entry reasons (kept for exit notifications/analytics). */
  reasons: string[];
}

/** Construct a new PENDING_ENTRY position from a sized intent. Pure. */
export function createPosition(
  intent: EntryIntent,
  risk: RiskDecision,
  nowMs: number,
  id: string,
): Position {
  return {
    id,
    strategyId: intent.strategyId,
    symbol: intent.symbol,
    side: intent.side,
    entryZone: { ...intent.entryZone },
    entryPrice: (intent.entryZone.low + intent.entryZone.high) / 2,
    stopPrice: intent.stopPrice,
    targetPrice: intent.targetPrice ?? null,
    qty: risk.qty,
    riskAmount: risk.riskAmount,
    riskModel: risk.model,
    openedAt: nowMs,
    filledAt: null,
    closedAt: null,
    ageBars: 0,
    entryDeadline: nowMs + intent.entryTtlMs,
    maxHoldMs: intent.maxHoldMs ?? null,
    maxHoldUntil: null, // armed at fill time (see fillPosition)
    status: "PENDING_ENTRY",
    exitPrice: null,
    exitReason: null,
    state: intent.state ? { ...intent.state } : {},
    reasons: [...intent.reasons],
  };
}

/** Transition PENDING_ENTRY → OPEN at `fillMs`; arms the max-hold deadline
 *  from the FILL time (the strategy's horizon starts when the trade starts). */
export function fillPosition(p: Position, fillPrice: number, fillMs: number): Position {
  return {
    ...p,
    status: "OPEN",
    entryPrice: fillPrice,
    filledAt: fillMs,
    maxHoldUntil: p.maxHoldMs != null ? fillMs + p.maxHoldMs : null,
  };
}

export function isOpen(p: Position): boolean {
  return p.status === "OPEN" || p.status === "PENDING_ENTRY";
}

/**
 * Persistence seam. Phase 2 backs this with `signal_outcomes` (additive
 * columns); the in-memory implementation below serves tests and paper runs.
 * Concurrency key is (symbol, strategyId) — two strategies may hold the same
 * symbol independently.
 */
export interface PositionStore {
  get(id: string): Promise<Position | null>;
  /** The open (PENDING_ENTRY|OPEN) position in a slot, if any. */
  getOpenBySlot(symbol: string, strategyId: string): Promise<Position | null>;
  listOpen(filter?: { symbol?: string; strategyId?: string }): Promise<Position[]>;
  /** Persist a new position. Returns the canonical record — a backing store
   *  may assign its own id, so callers must use the returned position. */
  insert(position: Position): Promise<Position>;
  update(position: Position): Promise<void>;
}

export class InMemoryPositionStore implements PositionStore {
  private readonly byId = new Map<string, Position>();
  private seq = 0;

  nextId(): string {
    return `pos_${++this.seq}`;
  }

  async get(id: string): Promise<Position | null> {
    return this.byId.get(id) ?? null;
  }

  async getOpenBySlot(symbol: string, strategyId: string): Promise<Position | null> {
    for (const p of this.byId.values()) {
      if (p.symbol === symbol && p.strategyId === strategyId && isOpen(p)) return p;
    }
    return null;
  }

  async listOpen(filter: { symbol?: string; strategyId?: string } = {}): Promise<Position[]> {
    return [...this.byId.values()].filter(
      (p) =>
        isOpen(p) &&
        (filter.symbol == null || p.symbol === filter.symbol) &&
        (filter.strategyId == null || p.strategyId === filter.strategyId),
    );
  }

  async insert(position: Position): Promise<Position> {
    this.byId.set(position.id, position);
    return position;
  }

  async update(position: Position): Promise<void> {
    this.byId.set(position.id, position);
  }
}
