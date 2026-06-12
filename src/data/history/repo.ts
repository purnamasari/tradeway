// Candle repository — all reads/writes for the `candles` table. Writes are
// idempotent (composite PK + ON CONFLICT DO NOTHING) and accept only CLOSED
// bars, so backfill/incremental/restart all reduce to "upsert what you have".
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { candlesTable } from "../../db/schema.js";
import type { Candle, Timeframe } from "../../types.js";
import { TIMEFRAME_SEC } from "../../types.js";

const INSERT_CHUNK = 1_000;

/** Insert candles, ignoring rows that already exist. Returns rows written.
 *  Forming bars (close time in the future) are dropped — the store contains
 *  closed bars only. */
export async function upsertCandles(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  nowSec = Math.floor(Date.now() / 1000),
): Promise<number> {
  const tfSec = TIMEFRAME_SEC[timeframe];
  const closed = candles.filter((c) => c.time + tfSec <= nowSec);
  let written = 0;
  for (let i = 0; i < closed.length; i += INSERT_CHUNK) {
    const chunk = closed.slice(i, i + INSERT_CHUNK).map((c) => ({
      symbol,
      timeframe,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    const res = await db.insert(candlesTable).values(chunk).onConflictDoNothing();
    // postgres-js returns count on the result object.
    written += (res as unknown as { count?: number }).count ?? chunk.length;
  }
  return written;
}

export interface CandleBounds {
  count: number;
  earliest: number | null; // unix sec
  latest: number | null;
}

export async function candleBounds(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
): Promise<CandleBounds> {
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
      earliest: sql<number | null>`min(${candlesTable.time})`,
      latest: sql<number | null>`max(${candlesTable.time})`,
    })
    .from(candlesTable)
    .where(and(eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, timeframe)));
  const r = rows[0]!;
  return { count: r.count, earliest: r.earliest, latest: r.latest };
}

/** Last `limit` candles at/before `beforeSec` (default: all time), oldest-first. */
export async function fetchLastCandles(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  beforeSec?: number,
): Promise<Candle[]> {
  const conds = [eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, timeframe)];
  if (beforeSec != null) conds.push(lte(candlesTable.time, beforeSec));
  const rows = await db
    .select({
      time: candlesTable.time,
      open: candlesTable.open,
      high: candlesTable.high,
      low: candlesTable.low,
      close: candlesTable.close,
      volume: candlesTable.volume,
    })
    .from(candlesTable)
    .where(and(...conds))
    .orderBy(desc(candlesTable.time))
    .limit(limit);
  return rows.reverse();
}

/** All bar open times in [fromSec, toSec], ascending (gap scans). */
export async function fetchCandleTimes(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
  fromSec?: number,
  toSec?: number,
): Promise<number[]> {
  const conds = [eq(candlesTable.symbol, symbol), eq(candlesTable.timeframe, timeframe)];
  if (fromSec != null) conds.push(gte(candlesTable.time, fromSec));
  if (toSec != null) conds.push(lte(candlesTable.time, toSec));
  const rows = await db
    .select({ time: candlesTable.time })
    .from(candlesTable)
    .where(and(...conds))
    .orderBy(asc(candlesTable.time));
  return rows.map((r) => r.time);
}

export interface GapRange {
  fromSec: number; // first missing bar open
  toSec: number; // last missing bar open
  missingBars: number;
}

/** Find internal gaps in a stored series (pure, for testability). */
export function findGaps(times: number[], tfSec: number): GapRange[] {
  const gaps: GapRange[] = [];
  for (let i = 1; i < times.length; i++) {
    const delta = times[i]! - times[i - 1]!;
    if (delta > tfSec) {
      gaps.push({
        fromSec: times[i - 1]! + tfSec,
        toSec: times[i]! - tfSec,
        missingBars: Math.round(delta / tfSec) - 1,
      });
    }
  }
  return gaps;
}

/** Bar opens not aligned to the timeframe grid (data-quality check). */
export function findMisaligned(times: number[], tfSec: number): number[] {
  // Daily bars open at 00:00 UTC; intraday bars align to their interval.
  return times.filter((t) => t % tfSec !== 0);
}
