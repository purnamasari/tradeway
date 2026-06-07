// Bybit v5 public market data. No API key required for these endpoints.
// Docs: https://bybit-exchange.github.io/docs/v5/market/kline
import type { Candle, Timeframe } from "../types.js";
import { logger } from "../logger.js";

const BASE = "https://api.bybit.com";

const INTERVAL: Record<Timeframe, string> = {
  "1m": "1",
  "15m": "15",
  "4h": "240",
};

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status} for ${path}`);
  const body = (await res.json()) as BybitResponse<T>;
  if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}: ${body.retMsg}`);
  return body.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delay between paginated requests to stay under Bybit public rate limits. */
const PAGE_DELAY_MS = 150;

/** get() with bounded exponential-backoff retry — for long backfill pagination. */
async function getWithRetry<T>(
  path: string,
  params: Record<string, string>,
  retries = 5,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await get<T>(path, params);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const backoff = Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 200);
      logger.warn(
        `[bybit] ${path} attempt ${attempt + 1}/${retries + 1} failed (${(err as Error).message}), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Fetch klines, returned oldest-first. */
export async function fetchCandles(
  symbol: string,
  tf: Timeframe,
  category: string,
  limit = 200,
): Promise<Candle[]> {
  const result = await get<{ list: string[][] }>("/v5/market/kline", {
    category,
    symbol,
    interval: INTERVAL[tf],
    limit: String(limit),
  });
  // Bybit returns newest-first: [start, open, high, low, close, volume, turnover]
  return result.list
    .map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .reverse();
}

export interface TickerInfo {
  lastPrice: number;
  fundingRate: number | null;
  openInterest: number | null;
}

/** Current ticker — last price, funding rate, open interest. */
export async function fetchTicker(symbol: string, category: string): Promise<TickerInfo> {
  const result = await get<{ list: Array<Record<string, string>> }>("/v5/market/tickers", {
    category,
    symbol,
  });
  const t = result.list[0];
  if (!t) throw new Error(`No ticker for ${symbol}`);
  return {
    lastPrice: Number(t.lastPrice),
    fundingRate: t.fundingRate !== undefined ? Number(t.fundingRate) : null,
    openInterest: t.openInterest !== undefined ? Number(t.openInterest) : null,
  };
}

/** Recent funding rate history for percentile windows (linear only). */
export async function fetchFundingHistory(
  symbol: string,
  category: string,
  limit = 200,
): Promise<number[]> {
  if (category !== "linear") return [];
  try {
    const result = await get<{ list: Array<{ fundingRate: string }> }>(
      "/v5/market/funding/history",
      { category, symbol, limit: String(limit) },
    );
    return result.list.map((r) => Number(r.fundingRate)).reverse();
  } catch (err) {
    logger.warn(`[bybit] funding history failed for ${symbol}: ${(err as Error).message}`);
    return [];
  }
}

/** Recent open-interest history for z-scores. */
export async function fetchOIHistory(
  symbol: string,
  category: string,
  limit = 200,
): Promise<number[]> {
  if (category !== "linear") return [];
  try {
    const result = await get<{ list: Array<{ openInterest: string }> }>(
      "/v5/market/open-interest",
      { category, symbol, intervalTime: "1h", limit: String(limit) },
    );
    return result.list.map((r) => Number(r.openInterest)).reverse();
  } catch (err) {
    logger.warn(`[bybit] OI history failed for ${symbol}: ${(err as Error).message}`);
    return [];
  }
}

// ── Historical backfill fetchers ────────────────────────────────────────────
// Paginated, retrying fetchers that walk a [startMs, endMs] window. Used by the
// one-time backfill subsystem; all return rows oldest-first.

/** A timestamped funding-rate observation. */
export interface FundingPoint {
  time: number; // unix seconds
  fundingRate: number;
}

/** A timestamped open-interest observation. */
export interface OIPoint {
  time: number; // unix seconds
  openInterest: number;
}

const KLINE_MAX = 1000; // Bybit kline page size
const HISTORY_MAX = 200; // funding / OI page size

/**
 * Fetch all klines in [startMs, endMs], paginating backward via the `end`
 * cursor. Returns oldest-first. Bybit caps each page at 1000.
 */
export async function fetchCandlesRange(
  symbol: string,
  tf: Timeframe,
  category: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursorEnd = endMs;

  while (cursorEnd > startMs) {
    const result = await getWithRetry<{ list: string[][] }>("/v5/market/kline", {
      category,
      symbol,
      interval: INTERVAL[tf],
      start: String(startMs),
      end: String(cursorEnd),
      limit: String(KLINE_MAX),
    });
    const rows = result.list; // newest-first
    if (rows.length === 0) break;

    for (const row of rows) {
      out.push({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
    }

    const oldestMs = Number(rows[rows.length - 1]![0]);
    if (rows.length < KLINE_MAX || oldestMs <= startMs) break;
    cursorEnd = oldestMs - 1;
    await sleep(PAGE_DELAY_MS);
  }

  // de-dup (page boundaries can overlap) and sort oldest-first
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time);
}

/**
 * Fetch funding-rate history in [startMs, endMs], paginating backward via the
 * `endTime` cursor. Returns oldest-first.
 */
export async function fetchFundingHistoryRange(
  symbol: string,
  category: string,
  startMs: number,
  endMs: number,
): Promise<FundingPoint[]> {
  if (category !== "linear") return [];
  const out: FundingPoint[] = [];
  let cursorEnd = endMs;

  while (cursorEnd > startMs) {
    const result = await getWithRetry<{
      list: Array<{ fundingRate: string; fundingRateTimestamp: string }>;
    }>("/v5/market/funding/history", {
      category,
      symbol,
      startTime: String(startMs),
      endTime: String(cursorEnd),
      limit: String(HISTORY_MAX),
    });
    const rows = result.list; // newest-first
    if (rows.length === 0) break;

    for (const r of rows) {
      out.push({
        time: Math.floor(Number(r.fundingRateTimestamp) / 1000),
        fundingRate: Number(r.fundingRate),
      });
    }

    const oldestMs = Number(rows[rows.length - 1]!.fundingRateTimestamp);
    if (rows.length < HISTORY_MAX || oldestMs <= startMs) break;
    cursorEnd = oldestMs - 1;
    await sleep(PAGE_DELAY_MS);
  }

  const seen = new Set<number>();
  return out
    .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
    .sort((a, b) => a.time - b.time);
}

/**
 * Fetch open-interest history in [startMs, endMs] at the given interval,
 * paginating via nextPageCursor. Returns oldest-first.
 */
export async function fetchOIHistoryRange(
  symbol: string,
  category: string,
  intervalTime: string,
  startMs: number,
  endMs: number,
): Promise<OIPoint[]> {
  if (category !== "linear") return [];
  const out: OIPoint[] = [];
  let cursor: string | undefined;

  // Bound the loop defensively; 90d @ 1h ≈ 2160 points = ~11 pages.
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = {
      category,
      symbol,
      intervalTime,
      startTime: String(startMs),
      endTime: String(endMs),
      limit: String(HISTORY_MAX),
    };
    if (cursor) params.cursor = cursor;

    const result = await getWithRetry<{
      list: Array<{ openInterest: string; timestamp: string }>;
      nextPageCursor?: string;
    }>("/v5/market/open-interest", params);

    for (const r of result.list) {
      out.push({
        time: Math.floor(Number(r.timestamp) / 1000),
        openInterest: Number(r.openInterest),
      });
    }

    if (!result.nextPageCursor || result.list.length === 0) break;
    cursor = result.nextPageCursor;
    await sleep(PAGE_DELAY_MS);
  }

  const seen = new Set<number>();
  return out
    .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
    .sort((a, b) => a.time - b.time);
}
