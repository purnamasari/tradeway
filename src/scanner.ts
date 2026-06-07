// Per-symbol scan pipeline:
//   market data -> regime -> trend -> S/R -> detectors -> gates -> chart -> alert
// Runs all permitted strategy detectors per regime and selects the
// highest combined-score signal.
import type { AssetConfig, GlobalConfig, Rules, Env } from "./config.js";
import type { Cache } from "./cache.js";
import type { Notifier } from "./notify.js";
import type { MarketContext, Signal } from "./types.js";
import type { Db } from "./db/index.js";
import { classifyRegime } from "./regime/engine.js";
import { classifyTrend } from "./ai/trend-classifier.js";
import { buildSR } from "./strategy/sr-engine.js";
import { detectLiquiditySweep } from "./strategy/liquidity-sweep.js";
import { detectTrendPullback } from "./strategy/trend-pullback.js";
import { detectSqueeze } from "./strategy/squeeze.js";
import {
  fetchHistoricalMetricsFromDb,
  recordMetrics,
  recordRegime,
  recordSignal,
  createOutcome,
} from "./db/accumulate.js";
import { ema } from "./indicators.js";
import { renderChart } from "./chart/renderer.js";
import { logger } from "./logger.js";

// Pluggable market-data source (live Bybit or offline mock).
export type ContextProvider = (symbol: string, category: string) => Promise<MarketContext>;

export interface ScannerDeps {
  cache: Cache;
  notifier: Notifier;
  rules: Rules;
  global: GlobalConfig;
  env: Env;
  db: Db;
  getContext: ContextProvider;
}

/** Combined score for ranking signals when multiple detectors fire. */
function combinedScore(s: Signal): number {
  return s.confidence * 0.6 + s.setup_quality * 0.4;
}

export async function scanSymbol(asset: AssetConfig, deps: ScannerDeps): Promise<void> {
  const { cache, notifier, rules, global, env, db } = deps;
  const minConfidence = asset.min_confidence ?? global.min_confidence;

  try {
    const ctx = await deps.getContext(asset.symbol, env.bybitCategory);
    if (ctx.candles15m.length < 60 || ctx.candles4h.length < 60) {
      logger.warn(`[scan] ${asset.symbol}: insufficient candle history, skipping`);
      return;
    }

    const dbMetrics = await fetchHistoricalMetricsFromDb(db, asset.symbol);
    const historyConfidence = dbMetrics
      ? Math.min(dbMetrics.recordCount / 100, 1.0)
      : 0.0;
    ctx.historyConfidence = historyConfidence;

    if (dbMetrics) {
      if (dbMetrics.oiHistory.length >= 30) {
        ctx.oiHistory = dbMetrics.oiHistory;
      }
      if (dbMetrics.fundingHistory.length >= 50) {
        ctx.fundingHistory = dbMetrics.fundingHistory;
      }
      if (dbMetrics.atrHistory.length >= 50) {
        ctx.atrHistory = dbMetrics.atrHistory;
      }
      if (dbMetrics.volumeHistory.length >= 50) {
        ctx.volumeHistory = dbMetrics.volumeHistory;
      }
    }

    const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);

    const closes4h = ctx.candles4h.map((c) => c.close);
    const ema20 = ema(closes4h, rules.regime.ema_fast);
    const ema50 = ema(closes4h, rules.regime.ema_slow);
    const trend = await classifyTrend(asset.symbol, ctx.candles4h, ema20, ema50, {
      cache,
      rules: rules.trend,
      geminiApiKey: env.geminiApiKey,
    });

    const price = ctx.candles15m.at(-1)!.close;
    const sr = buildSR(ctx.candles15m, price);

    logger.info(
      `[scan] ${asset.symbol} · regime=${regime.regime} (ADX ${regime.adx}, ATR%${regime.atrPercentile}) · trend=${trend.trend} (${trend.source})`,
    );

    // ── Persist metrics & regime (no-op if db is null) ────────────────────────
    await recordMetrics(db, ctx, regime);
    await recordRegime(db, asset.symbol, regime);

    // ── Run all permitted detectors ──────────────────────────────────────────
    const candidates: Signal[] = [];

    const sweep = detectLiquiditySweep(ctx, regime, trend, sr, rules);
    if (sweep.signal) candidates.push(sweep.signal);
    else logger.debug(`[scan] ${asset.symbol}: sweep — ${sweep.reason}`);

    const pullback = detectTrendPullback(ctx, regime, trend, sr, rules);
    if (pullback.signal) candidates.push(pullback.signal);
    else logger.debug(`[scan] ${asset.symbol}: pullback — ${pullback.reason}`);

    const squeeze = detectSqueeze(ctx, regime, trend, sr, rules);
    if (squeeze.signal) candidates.push(squeeze.signal);
    else logger.debug(`[scan] ${asset.symbol}: squeeze — ${squeeze.reason}`);

    if (candidates.length === 0) {
      logger.debug(`[scan] ${asset.symbol}: no signal from any detector`);
      return;
    }

    // Pick the highest combined-score signal.
    candidates.sort((a, b) => combinedScore(b) - combinedScore(a));
    const signal = candidates[0]!;

    if (candidates.length > 1) {
      logger.debug(
        `[scan] ${asset.symbol}: ${candidates.length} candidates, selected ${signal.strategy} (score ${combinedScore(signal).toFixed(1)})`,
      );
    }

    // ── Gates ─────────────────────────────────────────────────────────────────
    if (signal.confidence < minConfidence) {
      logger.debug(`[scan] ${asset.symbol}: confidence ${signal.confidence} < ${minConfidence}`);
      return;
    }
    if (signal.setup_quality < global.min_setup_quality) {
      logger.debug(`[scan] ${asset.symbol}: setup_quality ${signal.setup_quality} < ${global.min_setup_quality}`);
      return;
    }
    if (signal.rr < global.min_rr) {
      logger.debug(`[scan] ${asset.symbol}: RR ${signal.rr} < ${global.min_rr}`);
      return;
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────
    const cooldownKey = `cooldown:${asset.symbol}:${signal.strategy}`;
    if (await cache.get(cooldownKey)) {
      logger.debug(`[scan] ${asset.symbol}: in cooldown, suppressing duplicate`);
      return;
    }
    await cache.setex(cooldownKey, global.alert_cooldown_min * 60, "1");

    logger.info(
      `[scan] ✅ ${asset.symbol} ${signal.direction} ${signal.strategy} — conf ${signal.confidence}, quality ${signal.setup_quality}, RR 1:${signal.rr}`,
    );

    // ── Chart rendering (failure never blocks alert) ─────────────────────────
    let chartPng: Buffer | null = null;
    try {
      chartPng = await renderChart(signal, ctx.candles15m);
    } catch (err) {
      logger.warn(`[scan] Chart render failed for ${asset.symbol}: ${(err as Error).message}`);
    }

    // ── Persist signal, create outcome & notify ──────────────────────────────
    const signalId = await recordSignal(db, signal);
    if (signalId !== null) {
      await createOutcome(db, signal, signalId);
    }
    await notifier.send(signal, chartPng);
  } catch (err) {
    logger.error(`[scan] ${asset.symbol} failed: ${(err as Error).message}`);
  }
}
