// DB-backed PositionStore over the existing `signal_outcomes` table.
// Engine positions are rows with source='engine'; legacy and Bybit rows are
// invisible to this store and vice versa, so the two paths coexist safely.
//
// Mapping (Position ↔ signal_outcomes):
//   strategyId        ↔ strategy           (free-form id; legacy kinds remain valid)
//   side LONG/SHORT   ↔ direction long/short
//   stopPrice         ↔ sl                 (MUTABLE for engine rows — trailing ratchets it)
//   targetPrice null  ↔ tp = 0             (existing "no target" sentinel)
//   entryDeadline /
//   maxHoldUntil      ↔ expires_at         (same dual-use as the legacy tracker:
//                                           entry window before fill, hold window after)
//   status            ↔ PENDING_ENTRY→PENDING_ENTRY · OPEN→ACTIVE · EXITED_STOP→SL_HIT
//                       EXITED_TARGET→TP_HIT · EXITED_TIME/CANCELLED→EXPIRED
//                       EXITED_STRATEGY→CLOSED   (reverse: EXPIRED with no
//                       activated_at = CANCELLED; CLOSED on engine rows = strategy exit)
//   state             ↔ strategy_state (JSONB) · reasons ↔ entry_reasons (JSONB)
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { signalOutcomes } from "../db/schema.js";
import type { Position, PositionStatus, PositionStore } from "./position.js";
import type { Side } from "./types.js";

const ENGINE_SOURCE = "engine";
const OPEN_STATUSES = ["PENDING_ENTRY", "ACTIVE"];

type Row = typeof signalOutcomes.$inferSelect;

export function statusToRow(status: PositionStatus): string {
  switch (status) {
    case "PENDING_ENTRY": return "PENDING_ENTRY";
    case "OPEN": return "ACTIVE";
    case "EXITED_STOP": return "SL_HIT";
    case "EXITED_TARGET": return "TP_HIT";
    case "EXITED_TIME": return "EXPIRED";
    case "CANCELLED": return "EXPIRED";
    case "EXITED_STRATEGY": return "CLOSED";
  }
}

export function statusFromRow(row: { status: string; activated_at: Date | null }): PositionStatus {
  switch (row.status) {
    case "PENDING_ENTRY": return "PENDING_ENTRY";
    case "ACTIVE": return "OPEN";
    case "SL_HIT": return "EXITED_STOP";
    case "TP_HIT": return "EXITED_TARGET";
    case "EXPIRED": return row.activated_at == null ? "CANCELLED" : "EXITED_TIME";
    case "CLOSED": return "EXITED_STRATEGY";
    default: return "EXITED_STRATEGY";
  }
}

export function rowToPosition(row: Row): Position {
  return {
    id: String(row.id),
    strategyId: row.strategy,
    symbol: row.symbol,
    side: row.direction === "long" ? "LONG" : ("SHORT" as Side),
    entryZone: { low: row.entry_low, high: row.entry_high },
    entryPrice: row.entry_price,
    stopPrice: row.sl,
    targetPrice: row.tp === 0 ? null : row.tp,
    qty: row.qty ?? 0,
    riskAmount: row.risk_amount ?? 0,
    riskModel: row.risk_model ?? "advisory",
    openedAt: new Date(row.opened_at).getTime(),
    filledAt: row.activated_at ? new Date(row.activated_at).getTime() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
    ageBars: row.age_bars ?? 0,
    entryDeadline: new Date(row.expires_at).getTime(),
    maxHoldMs: row.max_hold_sec != null ? row.max_hold_sec * 1000 : null,
    maxHoldUntil: row.activated_at && row.max_hold_sec != null ? new Date(row.expires_at).getTime() : null,
    status: statusFromRow(row),
    exitPrice: row.hit_price,
    exitReason: row.exit_reason,
    state: (row.strategy_state as Record<string, unknown> | null) ?? {},
    reasons: (row.entry_reasons as string[] | null) ?? [],
  };
}

/** Column values shared by insert and update. */
export function positionToRow(p: Position): Record<string, unknown> {
  // expires_at carries the live deadline: entry window until fill, hold window after.
  const expiresAt =
    p.status === "PENDING_ENTRY" || p.filledAt == null
      ? new Date(p.entryDeadline)
      : new Date(p.maxHoldUntil ?? p.filledAt + 365 * 24 * 3_600_000);
  return {
    symbol: p.symbol,
    strategy: p.strategyId,
    direction: p.side === "LONG" ? "long" : "short",
    source: ENGINE_SOURCE,
    followed: true,
    status: statusToRow(p.status),
    entry_price: p.entryPrice,
    entry_low: p.entryZone.low,
    entry_high: p.entryZone.high,
    sl: p.stopPrice,
    tp: p.targetPrice ?? 0,
    hit_price: p.exitPrice,
    opened_at: new Date(p.openedAt),
    activated_at: p.filledAt != null ? new Date(p.filledAt) : null,
    closed_at: p.closedAt != null ? new Date(p.closedAt) : null,
    expires_at: expiresAt,
    duration_ms: p.closedAt != null && p.filledAt != null ? p.closedAt - p.filledAt : null,
    strategy_state: p.state,
    entry_reasons: p.reasons,
    qty: p.qty,
    risk_amount: p.riskAmount,
    risk_model: p.riskModel,
    age_bars: p.ageBars,
    exit_reason: p.exitReason,
    max_hold_sec: p.maxHoldMs != null ? Math.round(p.maxHoldMs / 1000) : null,
  };
}

export class DbPositionStore implements PositionStore {
  constructor(private readonly db: NonNullable<Db>) {}

  async get(id: string): Promise<Position | null> {
    const rows = await this.db
      .select()
      .from(signalOutcomes)
      .where(and(eq(signalOutcomes.id, Number(id)), eq(signalOutcomes.source, ENGINE_SOURCE)))
      .limit(1);
    return rows[0] ? rowToPosition(rows[0]) : null;
  }

  async getOpenBySlot(symbol: string, strategyId: string): Promise<Position | null> {
    const rows = await this.db
      .select()
      .from(signalOutcomes)
      .where(
        and(
          eq(signalOutcomes.source, ENGINE_SOURCE),
          eq(signalOutcomes.symbol, symbol),
          eq(signalOutcomes.strategy, strategyId),
          inArray(signalOutcomes.status, OPEN_STATUSES),
        ),
      )
      .limit(1);
    return rows[0] ? rowToPosition(rows[0]) : null;
  }

  async listOpen(filter: { symbol?: string; strategyId?: string } = {}): Promise<Position[]> {
    const conds = [
      eq(signalOutcomes.source, ENGINE_SOURCE),
      inArray(signalOutcomes.status, OPEN_STATUSES),
    ];
    if (filter.symbol) conds.push(eq(signalOutcomes.symbol, filter.symbol));
    if (filter.strategyId) conds.push(eq(signalOutcomes.strategy, filter.strategyId));
    const rows = await this.db.select().from(signalOutcomes).where(and(...conds));
    return rows.map(rowToPosition);
  }

  async insert(position: Position): Promise<Position> {
    const rows = await this.db
      .insert(signalOutcomes)
      .values({ signal_id: 0, ...positionToRow(position) } as typeof signalOutcomes.$inferInsert)
      .returning({ id: signalOutcomes.id });
    return { ...position, id: String(rows[0]!.id) };
  }

  async update(position: Position): Promise<void> {
    await this.db
      .update(signalOutcomes)
      .set(positionToRow(position) as Partial<typeof signalOutcomes.$inferInsert>)
      .where(and(eq(signalOutcomes.id, Number(position.id)), eq(signalOutcomes.source, ENGINE_SOURCE)));
  }
}
