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
