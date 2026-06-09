// Read-only analytics aggregations over signal_outcomes (+ signals for RR).
//
// Conventions:
//  - "resolved" = status IN ('TP_HIT','SL_HIT'); a win is TP_HIT. EXPIRED and still-open
//    rows are reported separately, never counted in win-rate.
//  - `days <= 0` means all-time; otherwise the window filters on opened_at.
//  - Counts are cast ::int and averages ::float8 so the postgres-js driver returns JS
//    numbers (bigint/numeric would otherwise come back as strings).
import type { Db } from "../db/index.js";
import { signalOutcomes } from "../db/schema.js";
import { and, eq, gte, sql, type SQL } from "drizzle-orm";

/**
 * Real-trades-and-in-window predicate. Always excludes shadow outcomes
 * (`followed = false`, created on Skip) so they never pollute performance metrics;
 * their counterfactual analysis is a separate, future view.
 */
function realFilter(days: number): SQL {
  const followed = eq(signalOutcomes.followed, true);
  if (days <= 0) return followed;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return and(followed, gte(signalOutcomes.opened_at, cutoff)) as SQL;
}

/** Resolved (TP/SL), real, in-window predicate (for win-rate breakdowns). */
function resolvedInWindow(days: number): SQL {
  return and(sql`${signalOutcomes.status} in ('TP_HIT','SL_HIT')`, realFilter(days)) as SQL;
}

// Reusable aggregate fragments.
const WINS = sql<number>`count(*) filter (where ${signalOutcomes.status} = 'TP_HIT')::int`;
const LOSSES = sql<number>`count(*) filter (where ${signalOutcomes.status} = 'SL_HIT')::int`;
const AVG_DURATION = sql<number | null>`avg(${signalOutcomes.duration_ms}) filter (where ${signalOutcomes.status} in ('TP_HIT','SL_HIT'))::float8`;

export interface CountsSummary {
  tp: number;
  sl: number;
  expired: number;
  open: number;
  total: number;
}

export async function summary(db: NonNullable<Db>, days: number): Promise<CountsSummary> {
  const rows = await db
    .select({
      tp: sql<number>`count(*) filter (where ${signalOutcomes.status} = 'TP_HIT')::int`,
      sl: sql<number>`count(*) filter (where ${signalOutcomes.status} = 'SL_HIT')::int`,
      expired: sql<number>`count(*) filter (where ${signalOutcomes.status} = 'EXPIRED')::int`,
      open: sql<number>`count(*) filter (where ${signalOutcomes.status} in ('PENDING_ENTRY','ACTIVE'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(signalOutcomes)
    .where(realFilter(days));
  return rows[0] ?? { tp: 0, sl: 0, expired: 0, open: 0, total: 0 };
}

export interface GroupRow {
  key: string;
  wins: number;
  losses: number;
  avgDurationMs: number | null;
}

/** Generic win-rate-by-dimension breakdown. `keyExpr` is the grouping SQL. */
async function groupBreakdown(
  db: NonNullable<Db>,
  days: number,
  keyExpr: SQL,
): Promise<GroupRow[]> {
  const rows = await db
    .select({ key: keyExpr, wins: WINS, losses: LOSSES, avgDurationMs: AVG_DURATION })
    .from(signalOutcomes)
    .where(resolvedInWindow(days))
    .groupBy(keyExpr);
  return rows.map((r) => ({
    key: String(r.key ?? "—"),
    wins: r.wins,
    losses: r.losses,
    avgDurationMs: r.avgDurationMs,
  }));
}

export const byStrategy = (db: NonNullable<Db>, days: number) =>
  groupBreakdown(db, days, sql`${signalOutcomes.strategy}`);
export const byDirection = (db: NonNullable<Db>, days: number) =>
  groupBreakdown(db, days, sql`${signalOutcomes.direction}`);
export const bySymbol = (db: NonNullable<Db>, days: number) =>
  groupBreakdown(db, days, sql`${signalOutcomes.symbol}`);
export const byRegime = (db: NonNullable<Db>, days: number) =>
  groupBreakdown(db, days, sql`coalesce(${signalOutcomes.original_factors}->>'regime', 'unknown')`);

/** Confidence calibration: actual win-rate per original_confidence bucket. */
export function byConfidenceBucket(db: NonNullable<Db>, days: number): Promise<GroupRow[]> {
  const bucket = sql`case
    when ${signalOutcomes.original_confidence} >= 90 then '90-100'
    when ${signalOutcomes.original_confidence} >= 80 then '80-89'
    when ${signalOutcomes.original_confidence} >= 70 then '70-79'
    when ${signalOutcomes.original_confidence} >= 60 then '60-69'
    else '<60' end`;
  return groupBreakdown(db, days, bucket);
}

/** Edge-monitor validation: win-rate grouped by the signal's terminal edge_state. */
export const byEdgeState = (db: NonNullable<Db>, days: number) =>
  groupBreakdown(db, days, sql`${signalOutcomes.edge_state}`);

export interface ConfidenceDecay {
  winnersDecay: number | null; // avg(original − live) for TP_HIT
  losersDecay: number | null; // avg(original − live) for SL_HIT
}

export async function confidenceDecay(db: NonNullable<Db>, days: number): Promise<ConfidenceDecay> {
  const diff = sql`(${signalOutcomes.original_confidence} - ${signalOutcomes.live_confidence})`;
  const rows = await db
    .select({
      winnersDecay: sql<number | null>`avg(${diff}) filter (where ${signalOutcomes.status} = 'TP_HIT')::float8`,
      losersDecay: sql<number | null>`avg(${diff}) filter (where ${signalOutcomes.status} = 'SL_HIT')::float8`,
    })
    .from(signalOutcomes)
    .where(and(resolvedInWindow(days), sql`${signalOutcomes.live_confidence} is not null`));
  return rows[0] ?? { winnersDecay: null, losersDecay: null };
}

export interface FactorEffectiveness {
  winFunding: number | null;
  lossFunding: number | null;
  winOiZscore: number | null;
  lossOiZscore: number | null;
}

export async function factorEffectiveness(
  db: NonNullable<Db>,
  days: number,
): Promise<FactorEffectiveness> {
  const funding = sql`(${signalOutcomes.original_factors}->>'funding_percentile')::float8`;
  const oi = sql`(${signalOutcomes.original_factors}->>'oi_zscore')::float8`;
  const rows = await db
    .select({
      winFunding: sql<number | null>`avg(${funding}) filter (where ${signalOutcomes.status} = 'TP_HIT')::float8`,
      lossFunding: sql<number | null>`avg(${funding}) filter (where ${signalOutcomes.status} = 'SL_HIT')::float8`,
      winOiZscore: sql<number | null>`avg(${oi}) filter (where ${signalOutcomes.status} = 'TP_HIT')::float8`,
      lossOiZscore: sql<number | null>`avg(${oi}) filter (where ${signalOutcomes.status} = 'SL_HIT')::float8`,
    })
    .from(signalOutcomes)
    .where(resolvedInWindow(days));
  return rows[0] ?? { winFunding: null, lossFunding: null, winOiZscore: null, lossOiZscore: null };
}

export interface Durations {
  tpMs: number | null; // avg time-to-TP
  slMs: number | null; // avg time-to-SL
}

export async function durations(db: NonNullable<Db>, days: number): Promise<Durations> {
  const rows = await db
    .select({
      tpMs: sql<number | null>`avg(${signalOutcomes.duration_ms}) filter (where ${signalOutcomes.status} = 'TP_HIT')::float8`,
      slMs: sql<number | null>`avg(${signalOutcomes.duration_ms}) filter (where ${signalOutcomes.status} = 'SL_HIT')::float8`,
    })
    .from(signalOutcomes)
    .where(resolvedInWindow(days));
  return rows[0] ?? { tpMs: null, slMs: null };
}

// ── Manual trades (autodetected Bybit positions) ──────────────────────────────
// Tracked separately from signal performance: these are the user's own trades, with
// no bot thesis, so mixing them into signal win-rate would be misleading. A CLOSED
// row's realized PnL% is derived from entry vs the exit price recorded at close.

export interface ManualTradesSummary {
  open: number;
  closed: number;
  wins: number; // closed with PnL > 0
  losses: number; // closed with PnL < 0
  avgPnlPct: number | null;
}

/** source='bybit' rows in the window (always followed=true; window filters opened_at). */
function manualInWindow(days: number): SQL {
  const isManual = eq(signalOutcomes.source, "bybit");
  if (days <= 0) return isManual;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return and(isManual, gte(signalOutcomes.opened_at, cutoff)) as SQL;
}

export async function manualTrades(db: NonNullable<Db>, days: number): Promise<ManualTradesSummary> {
  // Realized PnL% at close, direction-aware (entry vs recorded exit/hit_price).
  const pnl = sql`case when ${signalOutcomes.direction} = 'long'
      then (${signalOutcomes.hit_price} - ${signalOutcomes.entry_price}) / ${signalOutcomes.entry_price} * 100
      else (${signalOutcomes.entry_price} - ${signalOutcomes.hit_price}) / ${signalOutcomes.entry_price} * 100 end`;
  const closed = sql`${signalOutcomes.status} = 'CLOSED'`;
  const rows = await db
    .select({
      open: sql<number>`count(*) filter (where ${signalOutcomes.status} in ('PENDING_ENTRY','ACTIVE'))::int`,
      closed: sql<number>`count(*) filter (where ${closed})::int`,
      wins: sql<number>`count(*) filter (where ${closed} and ${pnl} > 0)::int`,
      losses: sql<number>`count(*) filter (where ${closed} and ${pnl} < 0)::int`,
      avgPnlPct: sql<number | null>`avg(${pnl}) filter (where ${closed})::float8`,
    })
    .from(signalOutcomes)
    .where(manualInWindow(days));
  return rows[0] ?? { open: 0, closed: 0, wins: 0, losses: 0, avgPnlPct: null };
}
