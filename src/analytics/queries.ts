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
import { and, gte, sql, type SQL } from "drizzle-orm";

/** Window predicate on opened_at, or undefined for all-time. */
function windowFilter(days: number): SQL | undefined {
  if (days <= 0) return undefined;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return gte(signalOutcomes.opened_at, cutoff);
}

/** Resolved-and-in-window predicate (for win-rate breakdowns). */
function resolvedInWindow(days: number): SQL {
  const resolved = sql`${signalOutcomes.status} in ('TP_HIT','SL_HIT')`;
  const w = windowFilter(days);
  return w ? (and(resolved, w) as SQL) : resolved;
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
    .where(windowFilter(days));
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
