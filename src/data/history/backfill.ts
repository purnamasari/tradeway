// Historical candle backfill — initial download, incremental top-up, and gap
// repair, all restart-safe: every run inspects what the DB already has and
// fetches only the missing ranges. Idempotent by construction (the repo's
// composite PK + DO NOTHING makes duplicate fetches harmless).
import type { Db } from "../../db/index.js";
import type { Timeframe } from "../../types.js";
import { TIMEFRAME_SEC } from "../../types.js";
import { fetchCandlesRange } from "../bybit.js";
import { candleBounds, fetchCandleTimes, findGaps, findMisaligned, upsertCandles, type GapRange } from "./repo.js";
import { logger } from "../../logger.js";

// "1M" is intentionally omitted: monthly bars lack a fixed second-stride, which
// breaks TIMEFRAME_SEC-based gap detection / bar-count verification below.
export const HISTORY_TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d", "1w"];

export interface BackfillOptions {
  /** Target history depth in days (head-fills if the DB has less). */
  days: number;
  /** Also scan for and re-fetch internal gaps. */
  repairGaps?: boolean;
}

export interface BackfillResult {
  symbol: string;
  timeframe: Timeframe;
  fetched: number; // candles received from the exchange
  written: number; // new rows actually inserted
  gapsRepaired: number;
}

/**
 * Bring one (symbol, timeframe) series up to date:
 *   cold start → fetch the full [now − days, now] range
 *   tail       → fetch (latest, now]            (incremental update)
 *   head       → fetch [now − days, earliest)   (deepening after a config change)
 *   gaps       → optional repair pass over internal holes
 */
export async function backfillSeries(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
  category: string,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const tfSec = TIMEFRAME_SEC[timeframe];
  const nowMs = Date.now();
  const targetStartMs = nowMs - opts.days * 86_400_000;
  const bounds = await candleBounds(db, symbol, timeframe);

  let fetched = 0;
  let written = 0;

  const pull = async (startMs: number, endMs: number): Promise<void> => {
    if (endMs <= startMs) return;
    const candles = await fetchCandlesRange(symbol, timeframe, category, startMs, endMs);
    fetched += candles.length;
    written += await upsertCandles(db, symbol, timeframe, candles);
  };

  if (bounds.latest == null || bounds.earliest == null) {
    logger.info(`[history] ${symbol} ${timeframe}: cold start, fetching ${opts.days}d`);
    await pull(targetStartMs, nowMs);
  } else {
    // Tail: everything after the last stored bar.
    await pull((bounds.latest + tfSec) * 1000, nowMs);
    // Head: deepen if the configured window reaches further back than stored.
    if (bounds.earliest * 1000 > targetStartMs + tfSec * 1000) {
      logger.info(`[history] ${symbol} ${timeframe}: deepening head to ${opts.days}d`);
      await pull(targetStartMs, (bounds.earliest - 1) * 1000);
    }
  }

  let gapsRepaired = 0;
  if (opts.repairGaps) {
    const times = await fetchCandleTimes(db, symbol, timeframe);
    const gaps = findGaps(times, tfSec);
    for (const gap of gaps) {
      await pull(gap.fromSec * 1000, (gap.toSec + tfSec) * 1000);
      gapsRepaired++;
    }
    if (gaps.length) {
      logger.info(`[history] ${symbol} ${timeframe}: repaired ${gaps.length} gap(s)`);
    }
  }

  logger.info(
    `[history] ${symbol} ${timeframe}: fetched ${fetched}, wrote ${written} new` +
      (gapsRepaired ? `, repaired ${gapsRepaired} gaps` : ""),
  );
  return { symbol, timeframe, fetched, written, gapsRepaired };
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface SeriesReport {
  symbol: string;
  timeframe: Timeframe;
  count: number;
  earliest: number | null;
  latest: number | null;
  /** Bars expected between earliest and latest if the series were complete. */
  expected: number;
  missing: number;
  gaps: GapRange[];
  misaligned: number;
  /** Bars behind the most recent closed bar (staleness). */
  lagBars: number;
}

export async function verifySeries(
  db: NonNullable<Db>,
  symbol: string,
  timeframe: Timeframe,
): Promise<SeriesReport> {
  const tfSec = TIMEFRAME_SEC[timeframe];
  const bounds = await candleBounds(db, symbol, timeframe);
  if (bounds.earliest == null || bounds.latest == null) {
    return {
      symbol, timeframe, count: 0, earliest: null, latest: null,
      expected: 0, missing: 0, gaps: [], misaligned: 0, lagBars: 0,
    };
  }
  const times = await fetchCandleTimes(db, symbol, timeframe);
  const gaps = findGaps(times, tfSec);
  const expected = Math.floor((bounds.latest - bounds.earliest) / tfSec) + 1;
  const lastClosedOpen = Math.floor((Date.now() / 1000 - tfSec) / tfSec) * tfSec;
  return {
    symbol,
    timeframe,
    count: bounds.count,
    earliest: bounds.earliest,
    latest: bounds.latest,
    expected,
    missing: expected - bounds.count,
    gaps,
    misaligned: findMisaligned(times, tfSec).length,
    lagBars: Math.max(0, Math.round((lastClosedOpen - bounds.latest) / tfSec)),
  };
}
