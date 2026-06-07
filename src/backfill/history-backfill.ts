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
  marketHistoryBounds,
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

/**
 * Compute the [start, end] ranges still missing for a series, given what's
 * already stored. Handles both the leading gap (new data since `latest`) and the
 * trailing gap (older data when the window was widened, e.g. candle_days 30→90),
 * so changing a window size is picked up on the next run without a manual wipe.
 *
 * `refetchLatest` re-pulls the most recent stored point (used for candles, whose
 * latest bar may have been in-progress when first stored).
 */
function missingRanges(
  bounds: { earliest: number | null; latest: number | null },
  windowStart: number,
  now: number,
  refetchLatest = false,
): Array<[number, number]> {
  const { earliest, latest } = bounds;
  if (earliest === null || latest === null) {
    return windowStart < now ? [[windowStart, now]] : [];
  }
  const ranges: Array<[number, number]> = [];
  if (earliest > windowStart) ranges.push([windowStart, earliest]); // trailing (widened window)
  const leadStart = refetchLatest ? latest : latest + 1;
  if (leadStart < now) ranges.push([leadStart, now]); // leading (new data)
  return ranges;
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
  const bounds = await marketHistoryBounds(db, symbol, "funding_rate");
  const ranges = missingRanges(bounds, windowStart, now);
  if (ranges.length === 0) return 0;

  const points: FundingPoint[] = [];
  for (const [start, end] of ranges) {
    points.push(...(await fetchFundingHistoryRange(symbol, category, start, end)));
  }
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
  const bounds = await marketHistoryBounds(db, symbol, "open_interest");
  const ranges = missingRanges(bounds, windowStart, now);
  if (ranges.length === 0) return 0;

  const points: OIPoint[] = [];
  for (const [start, end] of ranges) {
    points.push(...(await fetchOIHistoryRange(symbol, category, rules.backfill.oi_interval, start, end)));
  }
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
  const bounds = await marketHistoryBounds(db, symbol, "open");
  // refetchLatest: the most recent stored bar may have been in-progress — upsert refreshes it.
  const ranges = missingRanges(bounds, windowStart, now, true);
  if (ranges.length === 0) return 0;

  const candles: Candle[] = [];
  for (const [start, end] of ranges) {
    candles.push(...(await fetchCandlesRange(symbol, "15m", category, start, end)));
  }
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
    candleDays: rules.backfill.percentile_days,
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
