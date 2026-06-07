// Per-symbol scan pipeline:
//   market data -> regime -> trend -> S/R -> detector -> gates -> alert
import type { AssetConfig, GlobalConfig, Rules, Env } from "./config.js";
import type { Cache } from "./cache.js";
import type { Notifier } from "./notify.js";
import type { MarketContext } from "./types.js";
import { classifyRegime } from "./regime/engine.js";
import { classifyTrend } from "./ai/trend-classifier.js";
import { buildSR } from "./strategy/sr-engine.js";
import { detectLiquiditySweep } from "./strategy/liquidity-sweep.js";
import { ema } from "./indicators.js";
import { logger } from "./logger.js";

// Pluggable market-data source (live Bybit or offline mock).
export type ContextProvider = (symbol: string, category: string) => Promise<MarketContext>;

export interface ScannerDeps {
  cache: Cache;
  notifier: Notifier;
  rules: Rules;
  global: GlobalConfig;
  env: Env;
  getContext: ContextProvider;
}

export async function scanSymbol(asset: AssetConfig, deps: ScannerDeps): Promise<void> {
  const { cache, notifier, rules, global, env } = deps;
  const minConfidence = asset.min_confidence ?? global.min_confidence;

  try {
    const ctx = await deps.getContext(asset.symbol, env.bybitCategory);
    if (ctx.candles15m.length < 60 || ctx.candles4h.length < 60) {
      logger.warn(`[scan] ${asset.symbol}: insufficient candle history, skipping`);
      return;
    }

    const regime = classifyRegime(ctx.candles15m, rules.regime);

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

    const { signal, reason } = detectLiquiditySweep(ctx, regime, trend, sr, rules);
    if (!signal) {
      logger.debug(`[scan] ${asset.symbol}: no signal — ${reason}`);
      return;
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
      `[scan] ✅ ${asset.symbol} ${signal.direction} signal — conf ${signal.confidence}, quality ${signal.setup_quality}, RR 1:${signal.rr}`,
    );
    await notifier.send(signal);
  } catch (err) {
    logger.error(`[scan] ${asset.symbol} failed: ${(err as Error).message}`);
  }
}
