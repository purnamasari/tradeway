// Assembles a per-symbol MarketContext: all candles + funding/OI in one shot.
import type { MarketContext } from "../types.js";
import {
  fetchCandles,
  fetchTicker,
  fetchFundingHistory,
  fetchOIHistory,
} from "./bybit.js";

export async function buildMarketContext(
  symbol: string,
  category: string,
): Promise<MarketContext> {
  const [candles1m, candles15m, candles1h, ticker, fundingHistory, oiHistory] =
    await Promise.all([
      fetchCandles(symbol, "1m", category, 200),
      fetchCandles(symbol, "15m", category, 200),
      fetchCandles(symbol, "1h", category, 200),
      fetchTicker(symbol, category),
      fetchFundingHistory(symbol, category, 200),
      fetchOIHistory(symbol, category, 200),
    ]);

  return {
    symbol,
    candles1m,
    candles15m,
    candles1h,
    fundingRate: ticker.fundingRate,
    openInterest: ticker.openInterest,
    fundingHistory,
    oiHistory,
    historyConfidence: 0.0,
  };
}
