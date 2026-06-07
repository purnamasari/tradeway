// One-time historical market-data backfill.
//
// Bootstraps the percentile/z-score windows (funding, OI, volume, ATR) from
// Bybit historical data so adaptive thresholds are statistically meaningful
// immediately after deploy instead of after days/weeks of runtime accumulation.
//
// Design: store RAW market data (OHLCV, open_interest, funding_rate) in
// market_history — never derived indicators. ATR/volatility are computed on
// demand from the raw candles, so indicator-formula changes never require a
// re-backfill.
//
// Properties:
//   • Idempotent  — upsert on (symbol, timestamp); safe to run repeatedly.
//   • Incremental — only fetches ranges newer than what's already stored.
//   • Batched     — multi-row inserts, never one row at a time.
//   • Rate-limited & retrying — see data/bybit.ts pagination helpers.
import type { Db } from "../db/index.js";
import type { Rules } from "../config.js";
import { marketHistory } from "../db/schema.js";
import {
  fetchCandlesRange,
  fetchFundingHistoryRange,
  fetchOIHistoryRange,
  type FundingPoint,
  type OIPoint,
} from "../data/bybit.js";
import {
  fetchHistoricalContextFromMarketHistory,
  latestMarketHistoryTime,
} from "../db/accumulate.js";
import type { Candle } from "../types.js";
import { logger } from "../logger.js";
import { sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

type InsertRow = typeof marketHistory.$inferInsert;

/** Chunked upsert. `set` controls which columns merge on (symbol, timestamp) conflict. */
async function upsert(
  db: NonNullable<Db>,
  rows: InsertRow[],
  set: Record<string, unknown>,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(marketHistory)
      .values(chunk)
      .onConflictDoUpdate({
        target: [marketHistory.symbol, marketHistory.timestamp],
        set,
      });
    n += chunk.length;
  }
  return n;
}

/** Where to start an incremental fetch: just after the latest stored point, or windowStart. */
function incrementalStart(latest: number | null, windowStart: number): number {
  return latest !== null ? Math.max(windowStart, latest + 1) : windowStart;
}

// ── Per-category backfill ─────────────────────────────────────────────────────

export async function backfillFundingHistory(
  db: NonNullable<Db>,
  symbol: string,
  category: string,
  rules: Rules,
): Promise<number> {
  const now = Date.now();
  const windowStart = now - rules.backfill.funding_days * DAY_MS;
  const latest = await latestMarketHistoryTime(db, symbol, "funding_rate");
  const start = incrementalStart(latest, windowStart);
  if (start >= now) return 0;

  const points: FundingPoint[] = await fetchFundingHistoryRange(symbol, category, start, now);
  if (points.length === 0) return 0;

  const rows: InsertRow[] = points.map((p) => ({
    symbol,
    timestamp: new Date(p.time * 1000),
    funding_rate: p.fundingRate,
  }));
  const inserted = await upsert(db, rows, { funding_rate: sql`excluded.funding_rate` });
  logger.info(`[backfill] ${symbol} funding: inserted ${inserted} rows`);
  return inserted;
}

export async function backfillOpenInterestHistory(
  db: NonNullable<Db>,
  symbol: string,
  category: string,
  rules: Rules,
): Promise<number> {
  const now = Date.now();
  const windowStart = now - rules.backfill.oi_days * DAY_MS;
  const latest = await latestMarketHistoryTime(db, symbol, "open_interest");
  const start = incrementalStart(latest, windowStart);
  if (start >= now) return 0;

  const points: OIPoint[] = await fetchOIHistoryRange(
    symbol,
    category,
    rules.backfill.oi_interval,
    start,
    now,
  );
  if (points.length === 0) return 0;

  const rows: InsertRow[] = points.map((p) => ({
    symbol,
    timestamp: new Date(p.time * 1000),
    open_interest: p.openInterest,
  }));
  const inserted = await upsert(db, rows, { open_interest: sql`excluded.open_interest` });
  logger.info(`[backfill] ${symbol} oi: inserted ${inserted} rows`);
  return inserted;
}

export async function backfillCandleHistory(
  db: NonNullable<Db>,
  symbol: string,
  category: string,
  rules: Rules,
): Promise<number> {
  const now = Date.now();
  const windowStart = now - rules.backfill.candle_days * DAY_MS;
  const latest = await latestMarketHistoryTime(db, symbol, "open");
  // Re-fetch the latest stored candle (it may have been in-progress) — upsert handles it.
  const start = latest !== null ? Math.max(windowStart, latest) : windowStart;
  if (start > now) return 0;

  const candles: Candle[] = await fetchCandlesRange(symbol, "15m", category, start, now);
  if (candles.length === 0) return 0;

  const rows: InsertRow[] = candles.map((c) => ({
    symbol,
    timestamp: new Date(c.time * 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  const inserted = await upsert(db, rows, {
    open: sql`excluded.open`,
    high: sql`excluded.high`,
    low: sql`excluded.low`,
    close: sql`excluded.close`,
    volume: sql`excluded.volume`,
  });
  logger.info(`[backfill] ${symbol} candles: inserted ${inserted} rows`);
  return inserted;
}

/** Backfill all three data series for one symbol. Returns rows inserted. */
export async function backfillSymbol(
  db: NonNullable<Db>,
  symbol: string,
  category: string,
  rules: Rules,
): Promise<number> {
  let total = 0;
  // Sequential per-symbol to keep request rate gentle.
  total += await backfillFundingHistory(db, symbol, category, rules);
  total += await backfillOpenInterestHistory(db, symbol, category, rules);
  total += await backfillCandleHistory(db, symbol, category, rules);
  return total;
}

/** Run the full historical backfill across the given symbols. */
export async function runHistoricalBackfill(
  db: Db,
  category: string,
  symbols: string[],
  rules: Rules,
): Promise<void> {
  if (!db) {
    logger.warn("[backfill] skipped — no database configured");
    return;
  }
  if (category !== "linear") {
    logger.warn(`[backfill] skipped — category=${category} (funding/OI need linear)`);
    return;
  }

  const startedAt = Date.now();
  let rowsInserted = 0;
  for (const symbol of symbols) {
    try {
      rowsInserted += await backfillSymbol(db, symbol, category, rules);
    } catch (err) {
      logger.error(`[backfill] ${symbol} failed: ${(err as Error).message}`);
    }
  }
  const duration = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    `[backfill] completed symbols=${symbols.length} rows_inserted=${rowsInserted} duration=${duration}s`,
  );
}

// ── Startup bootstrap ─────────────────────────────────────────────────────────

/** True if a symbol lacks enough historical context for meaningful statistics. */
export async function historicalContextInsufficient(
  db: Db,
  symbol: string,
  rules: Rules,
): Promise<boolean> {
  if (!db) return false; // no DB → nothing to bootstrap
  const ctx = await fetchHistoricalContextFromMarketHistory(db, symbol, {
    fundingDays: rules.backfill.funding_days,
    oiDays: rules.backfill.oi_days,
    candleDays: rules.backfill.candle_days,
    atrPeriod: rules.regime.atr_period,
  });
  if (!ctx) return true;
  return (
    ctx.fundingHistory.length < rules.backfill.min_funding ||
    ctx.oiHistory.length < rules.backfill.min_oi ||
    ctx.volumeHistory.length < rules.backfill.min_volume ||
    ctx.recordCount < rules.backfill.min_candles
  );
}

/** At startup: backfill only the symbols that currently lack sufficient context. */
export async function bootstrapHistoryIfNeeded(
  db: Db,
  category: string,
  symbols: string[],
  rules: Rules,
): Promise<void> {
  if (!db) return;
  const needed: string[] = [];
  for (const symbol of symbols) {
    if (await historicalContextInsufficient(db, symbol, rules)) needed.push(symbol);
  }
  if (needed.length === 0) {
    logger.info("[backfill] historical context sufficient for all symbols — skipping bootstrap");
    return;
  }
  logger.info(`[backfill] bootstrapping ${needed.length}/${symbols.length} symbols: ${needed.join(", ")}`);
  await runHistoricalBackfill(db, category, needed, rules);
}
