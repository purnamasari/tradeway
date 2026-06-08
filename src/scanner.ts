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
import { detectMomentum } from "./strategy/momentum.js";
import {
  hydrateContextHistory,
  recordMetrics,
  recordRegime,
  recordSignal,
  createOutcome,
  fetchOpenOutcomeForSymbol,
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

/**
 * Run the full pipeline for one symbol. Returns a one-line summary of the outcome
 * (alert / no-signal / gated / suppressed / error) so callers like the `/scan`
 * command can report the result; the scheduler ignores the return value.
 */
export async function scanSymbol(asset: AssetConfig, deps: ScannerDeps): Promise<string> {
  const { cache, notifier, rules, global, env, db } = deps;
  const minConfidence = asset.min_confidence ?? global.min_confidence;

  // Heartbeat for the health endpoint. Any non-throwing exit (including the early
  // "no signal"/gate/cooldown returns) is a successful pass; a thrown error is a
  // failure. The `threw` flag lets `finally` tell the two apart across all the
  // early returns without sprinkling calls at every exit point.
  let threw = false;
  try {
    const ctx = await deps.getContext(asset.symbol, env.bybitCategory);
    if (ctx.candles15m.length < 60 || ctx.candles1h.length < 60) {
      logger.warn(`[scan] ${asset.symbol}: insufficient candle history, skipping`);
      return `${asset.symbol}: insufficient candle history`;
    }

    // Historical context = backfilled market_history (bulk bootstrap) merged with
    // runtime metric_history (accumulated per scan), folded into ctx's percentile/
    // z-score windows. Shared with the edge monitor so both score identically.
    await hydrateContextHistory(db, ctx, rules);

    const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);

    const closes1h = ctx.candles1h.map((c) => c.close);
    const ema20 = ema(closes1h, rules.regime.ema_fast);
    const ema50 = ema(closes1h, rules.regime.ema_slow);
    const trend = await classifyTrend(asset.symbol, ctx.candles1h, ema20, ema50, {
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
      { strategy: "momentum", result: detectMomentum(ctx, regime, trend, sr, rules) },
    ];
    const candidates = entries.map((e) => e.result.signal).filter((s): s is Signal => s !== null);

    if (candidates.length === 0) {
      logScanDecision(asset.symbol, regime, trend, entries, "no signal — all detectors rejected");
      return `${asset.symbol}: no signal (regime ${regime.regime}, trend ${trend.trend})`;
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
      return `${asset.symbol}: ${signal.strategy} gated — ${gateReason}`;
    }

    // ── Active-signal registry (one active signal per symbol) ────────────────────
    // If this symbol already has an open signal (PENDING_ENTRY or ACTIVE), suppress a
    // new one — the edge monitor sends updates on the existing signal instead. The
    // slot stays occupied even when the edge is INVALIDATED (no auto-close); it frees
    // only when price resolves (TP/SL/expiry). DB-less mode has no registry, so the
    // cooldown below remains the fallback dedupe there.
    const openOutcome = await fetchOpenOutcomeForSymbol(db, asset.symbol);
    if (openOutcome) {
      logScanDecision(
        asset.symbol,
        regime,
        trend,
        entries,
        `suppressed: active signal exists (#${openOutcome.id} ${openOutcome.status}, edge=${openOutcome.edge_state})`,
      );
      return `${asset.symbol}: suppressed — active signal #${openOutcome.id} (${openOutcome.status}, edge ${openOutcome.edge_state})`;
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────
    const cooldownKey = `cooldown:${asset.symbol}:${signal.strategy}`;
    if (await cache.get(cooldownKey)) {
      logScanDecision(asset.symbol, regime, trend, entries, `cooldown: suppressing duplicate ${signal.strategy}`);
      return `${asset.symbol}: cooldown — ${signal.strategy} suppressed`;
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

    // ── Persist signal, (maybe) create outcome & notify ───────────────────────
    // When require_follow is on and the notifier is interactive (Telegram), the
    // signal is NOT tracked yet — the user activates it by pressing Follow, which
    // creates the outcome. Otherwise (console, or flag off) auto-track as before.
    const signalId = await recordSignal(db, signal);
    const followable = rules.lifecycle.require_follow && notifier.interactive && signalId !== null;
    if (signalId !== null && !followable) {
      await createOutcome(db, signal, signalId);
    }
    await notifier.send(signal, chartPng, { signalId: signalId ?? undefined, followable });

    return (
      `${asset.symbol}: ✅ ${signal.direction} ${signal.strategy} ` +
      `(conf ${signal.confidence}, quality ${signal.setup_quality}, RR 1:${signal.rr})` +
      (followable ? " — Follow to track" : "")
    );
  } catch (err) {
    threw = true;
    recordScanError(asset.symbol, (err as Error).message);
    logger.error(`[scan] ${asset.symbol} failed: ${(err as Error).message}`);
    return `${asset.symbol}: scan error — ${(err as Error).message}`;
  } finally {
    if (!threw) recordScanSuccess(asset.symbol);
  }
}
