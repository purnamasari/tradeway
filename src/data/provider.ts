// MarketDataProvider — the candle-access seam for the strategy engine and all
// future strategies. Contract:
//   - returns up to `limit` candles, OLDEST-FIRST
//   - the last candle is the most recent CLOSED bar (never a forming bar)
//   - strategies consume this interface, never research files or raw REST
//
// Implementations:
//   DbMarketDataProvider     — reads the `candles` table (kept fresh by
//                              pnpm fetch:history and/or hybrid write-through)
//   LiveMarketDataProvider   — Bybit REST, for ad-hoc use where DB is absent
//   HybridMarketDataProvider — DB depth + live tail top-up with write-through
//   CachingMarketDataProvider— in-memory series cache; refreshes only when a
//                              new bar is due (bounds DB egress for 60s loops)
import type { Db } from "../db/index.js";
import type { Candle, Timeframe } from "../types.js";
import { TIMEFRAME_SEC } from "../types.js";
import { fetchCandles, fetchCandlesRange } from "./bybit.js";
import { fetchLastCandles, upsertCandles } from "./history/repo.js";
import { logger } from "../logger.js";

export interface MarketDataProvider {
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
}

const lastClosedOpen = (tfSec: number, nowSec: number): number =>
  Math.floor((nowSec - tfSec) / tfSec) * tfSec;

const dropForming = (candles: Candle[], tfSec: number, nowSec: number): Candle[] =>
  candles.filter((c) => c.time + tfSec <= nowSec);

export class DbMarketDataProvider implements MarketDataProvider {
  constructor(private readonly db: NonNullable<Db>) {}

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    return fetchLastCandles(this.db, symbol, timeframe, limit);
  }
}

export class LiveMarketDataProvider implements MarketDataProvider {
  constructor(private readonly category: string) {}

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const tfSec = TIMEFRAME_SEC[timeframe];
    const nowSec = Math.floor(Date.now() / 1000);
    // Single page when it fits; otherwise the paginated range fetcher.
    const candles =
      limit <= 1000
        ? await fetchCandles(symbol, timeframe, this.category, Math.min(1000, limit + 1))
        : await fetchCandlesRange(
            symbol,
            timeframe,
            this.category,
            (lastClosedOpen(tfSec, nowSec) - limit * tfSec) * 1000,
            Date.now(),
          );
    return dropForming(candles, tfSec, nowSec).slice(-limit);
  }
}

/**
 * DB for depth, live REST for the most recent bars, write-through so the DB
 * stays warm between fetch:history runs. The production engine provider.
 */
export class HybridMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly db: NonNullable<Db>,
    private readonly category: string,
  ) {}

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const tfSec = TIMEFRAME_SEC[timeframe];
    const nowSec = Math.floor(Date.now() / 1000);
    const stored = await fetchLastCandles(this.db, symbol, timeframe, limit);
    const latest = stored.at(-1)?.time ?? null;
    const targetLatest = lastClosedOpen(tfSec, nowSec);

    if (latest != null && latest >= targetLatest && stored.length >= limit) return stored;

    // Top up the missing tail from the exchange and write it through.
    const fromMs = latest != null ? (latest + tfSec) * 1000 : (targetLatest - limit * tfSec) * 1000;
    try {
      const fresh = dropForming(
        await fetchCandlesRange(symbol, timeframe, this.category, fromMs, Date.now()),
        tfSec,
        nowSec,
      );
      if (fresh.length) {
        await upsertCandles(this.db, symbol, timeframe, fresh, nowSec);
        const merged = [...stored, ...fresh.filter((c) => latest == null || c.time > latest)];
        return merged.slice(-limit);
      }
    } catch (err) {
      logger.warn(`[provider] live top-up failed for ${symbol} ${timeframe}: ${(err as Error).message}`);
    }
    return stored;
  }
}

/**
 * Per-(symbol,timeframe) in-memory cache. Serves from memory until a new bar
 * is due, then asks the underlying provider only for what changed. Keeps a
 * 60-second engine loop from re-reading thousands of rows per cycle.
 */
export class CachingMarketDataProvider implements MarketDataProvider {
  private readonly cache = new Map<string, { candles: Candle[]; limit: number }>();

  constructor(private readonly inner: MarketDataProvider) {}

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const tfSec = TIMEFRAME_SEC[timeframe];
    const nowSec = Math.floor(Date.now() / 1000);
    const key = `${symbol}:${timeframe}`;
    const hit = this.cache.get(key);
    const targetLatest = lastClosedOpen(tfSec, nowSec);

    if (hit && hit.limit >= limit && (hit.candles.at(-1)?.time ?? -1) >= targetLatest) {
      return hit.candles.slice(-limit);
    }

    const candles = await this.inner.getCandles(symbol, timeframe, Math.max(limit, hit?.limit ?? 0));
    this.cache.set(key, { candles, limit: Math.max(limit, hit?.limit ?? 0) });
    return candles.slice(-limit);
  }
}
