// Quick test script: generates a chart PNG to disk for visual inspection.
import { buildMockContext } from "./data/mock.js";
import { classifyRegime } from "./regime/engine.js";
import { classifyTrend } from "./ai/trend-classifier.js";
import { buildSR } from "./strategy/sr-engine.js";
import { detectLiquiditySweep } from "./strategy/liquidity-sweep.js";
import { detectTrendPullback } from "./strategy/trend-pullback.js";
import { detectSqueeze } from "./strategy/squeeze.js";
import { renderChart, closeBrowser } from "./chart/renderer.js";
import { createCache } from "./cache.js";
import { loadRules } from "./config.js";
import { ema } from "./indicators.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch {}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..");

async function main() {
  const rules = loadRules();
  const cache = await createCache();

  // Generate a sweep scenario for BTCUSDT
  const ctx = await buildMockContext("BTCUSDT", "linear", "sweep");
  const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);
  const closes4h = ctx.candles4h.map((c) => c.close);
  const ema20 = ema(closes4h, rules.regime.ema_fast);
  const ema50 = ema(closes4h, rules.regime.ema_slow);
  const trend = await classifyTrend("BTCUSDT", ctx.candles4h, ema20, ema50, {
    cache,
    rules: rules.trend,
  });
  const price = ctx.candles15m.at(-1)!.close;
  const sr = buildSR(ctx.candles15m, price);

  const sweep = detectLiquiditySweep(ctx, regime, trend, sr, rules);
  const pullback = detectTrendPullback(ctx, regime, trend, sr, rules);
  const squeeze = detectSqueeze(ctx, regime, trend, sr, rules);

  const signal = sweep.signal || pullback.signal || squeeze.signal;
  if (!signal) {
    console.log("No signal detected");
    process.exit(1);
  }

  console.log(`Signal: ${signal.symbol} ${signal.direction} ${signal.strategy}`);
  console.log(`Conf: ${signal.confidence}, Quality: ${signal.setup_quality}, RR: 1:${signal.rr}`);

  const chart = await renderChart(signal, ctx.candles15m);
  if (chart) {
    const outPath = join(outDir, "test-chart.png");
    writeFileSync(outPath, chart);
    console.log(`Chart saved to ${outPath} (${chart.byteLength} bytes)`);
  } else {
    console.log("Chart rendering failed");
  }

  await closeBrowser();
}

main().catch(console.error);
