// Per-symbol scan pipeline:
//   market data -> regime -> trend -> S/R -> detectors -> gates -> chart -> alert
// Runs all permitted strategy detectors per regime and selects the
// highest combined-score signal.
import type { AssetConfig, GlobalConfig, Rules, Env } from "./config.js";
import type { Cache } from "./cache.js";
import type { Notifier } from "./notify.js";
import type { MarketContext, Signal, RegimeResult, TrendResult, StrategyKind } from "./types.js";
import type { Db } from "./db/index.js";
import { classifyRegime } from "./regime/engine.js";
import { classifyTrend } from "./ai/trend-classifier.js";
import { buildSR } from "./strategy/sr-engine.js";
import { detectLiquiditySweep, type DetectResult } from "./strategy/liquidity-sweep.js";
import { detectTrendPullback } from "./strategy/trend-pullback.js";
import { detectSqueeze } from "./strategy/squeeze.js";
import {
  fetchHistoricalMetricsFromDb,
  fetchHistoricalContextFromMarketHistory,
  recordMetrics,
  recordRegime,
  recordSignal,
  createOutcome,
} from "./db/accumulate.js";
import { ema } from "./indicators.js";
import { renderChart } from "./chart/renderer.js";
import { logger } from "./logger.js";
import { recordScanSuccess, recordScanError } from "./health.js";

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

interface DetectorEntry {
  strategy: StrategyKind;
  result: DetectResult;
}

/**
 * Per-scan decision report. Explains, for every detector, whether it fired or
 * why it was rejected, plus the final gate outcome — so a missing alert is
 * always traceable to a specific reason rather than silent.
 */
function logScanDecision(
  symbol: string,
  regime: RegimeResult,
  trend: TrendResult,
  entries: DetectorEntry[],
  outcome: string,
): void {
  const lines = [
    `[scan] ${symbol} · regime=${regime.regime} (ADX ${regime.adx}, ATR%${regime.atrPercentile}) · trend=${trend.trend} (${trend.source})`,
  ];
  for (const { strategy, result } of entries) {
    const label = `${strategy}:`.padEnd(17);
    if (result.signal) {
      const s = result.signal;
      lines.push(`  ${label}detected — conf ${s.confidence}, quality ${s.setup_quality}, RR 1:${s.rr}`);
    } else {
      lines.push(`  ${label}rejected: ${result.reason}`);
    }
  }
  lines.push(`  ${outcome}`);
  logger.info(lines.join("\n"));
}

export async function scanSymbol(asset: AssetConfig, deps: ScannerDeps): Promise<void> {
  const { cache, notifier, rules, global, env, db } = deps;
  const minConfidence = asset.min_confidence ?? global.min_confidence;

  // Heartbeat for the health endpoint. Any non-throwing exit (including the early
  // "no signal"/gate/cooldown returns) is a successful pass; a thrown error is a
  // failure. The `threw` flag lets `finally` tell the two apart across all the
  // early returns without sprinkling calls at every exit point.
  let threw = false;
  try {
    const ctx = await deps.getContext(asset.symbol, env.bybitCategory);
    if (ctx.candles15m.length < 60 || ctx.candles4h.length < 60) {
      logger.warn(`[scan] ${asset.symbol}: insufficient candle history, skipping`);
      return;
    }

    // Historical context = backfilled market_history (bulk bootstrap) merged with
    // runtime metric_history (accumulated per scan). Concatenated into one window
    // per metric — order is irrelevant for percentile/z-score distributions.
    const marketHist = await fetchHistoricalContextFromMarketHistory(db, asset.symbol, {
      fundingDays: rules.backfill.funding_days,
      oiDays: rules.backfill.oi_days,
      candleDays: rules.backfill.candle_days,
      atrPeriod: rules.regime.atr_period,
    });
    const metricHist = await fetchHistoricalMetricsFromDb(db, asset.symbol);

    const fundingHistory = [...(marketHist?.fundingHistory ?? []), ...(metricHist?.fundingHistory ?? [])];
    const oiHistory = [...(marketHist?.oiHistory ?? []), ...(metricHist?.oiHistory ?? [])];
    const atrHistory = [...(marketHist?.atrHistory ?? []), ...(metricHist?.atrHistory ?? [])];
    const volumeHistory = [...(marketHist?.volumeHistory ?? []), ...(metricHist?.volumeHistory ?? [])];
    const recordCount = (marketHist?.recordCount ?? 0) + (metricHist?.recordCount ?? 0);

    ctx.historyConfidence = Math.min(recordCount / 100, 1.0);
    if (oiHistory.length >= 30) ctx.oiHistory = oiHistory;
    if (fundingHistory.length >= 50) ctx.fundingHistory = fundingHistory;
    if (atrHistory.length >= 50) ctx.atrHistory = atrHistory;
    if (volumeHistory.length >= 50) ctx.volumeHistory = volumeHistory;

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

    // ── Persist metrics & regime (no-op if db is null) ────────────────────────
    await recordMetrics(db, ctx, regime);
    await recordRegime(db, asset.symbol, regime);

    // ── Run all permitted detectors ──────────────────────────────────────────
    const entries: DetectorEntry[] = [
      { strategy: "liquidity_sweep", result: detectLiquiditySweep(ctx, regime, trend, sr, rules) },
      { strategy: "trend_pullback", result: detectTrendPullback(ctx, regime, trend, sr, rules) },
      { strategy: "squeeze", result: detectSqueeze(ctx, regime, trend, sr, rules) },
    ];
    const candidates = entries.map((e) => e.result.signal).filter((s): s is Signal => s !== null);

    if (candidates.length === 0) {
      logScanDecision(asset.symbol, regime, trend, entries, "no signal — all detectors rejected");
      return;
    }

    // Pick the highest combined-score signal.
    candidates.sort((a, b) => combinedScore(b) - combinedScore(a));
    const signal = candidates[0]!;

    // ── Gates ─────────────────────────────────────────────────────────────────
    let gateReason: string | null = null;
    if (signal.confidence < minConfidence) {
      gateReason = `confidence ${signal.confidence} < ${minConfidence}`;
    } else if (signal.setup_quality < global.min_setup_quality) {
      gateReason = `setup_quality ${signal.setup_quality} < ${global.min_setup_quality}`;
    } else if (signal.rr < global.min_rr) {
      gateReason = `RR ${signal.rr} < ${global.min_rr}`;
    }
    if (gateReason) {
      logScanDecision(asset.symbol, regime, trend, entries, `gate: ${signal.strategy} ${gateReason}`);
      return;
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────
    const cooldownKey = `cooldown:${asset.symbol}:${signal.strategy}`;
    if (await cache.get(cooldownKey)) {
      logScanDecision(asset.symbol, regime, trend, entries, `cooldown: suppressing duplicate ${signal.strategy}`);
      return;
    }
    await cache.setex(cooldownKey, global.alert_cooldown_min * 60, "1");

    logScanDecision(
      asset.symbol,
      regime,
      trend,
      entries,
      `gate: ✅ passed → alert ${signal.direction} ${signal.strategy}`,
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
    threw = true;
    recordScanError(asset.symbol, (err as Error).message);
    logger.error(`[scan] ${asset.symbol} failed: ${(err as Error).message}`);
  } finally {
    if (!threw) recordScanSuccess(asset.symbol);
  }
}
