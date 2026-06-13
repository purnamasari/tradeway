// Backtest CLI. Replays history through the real detectors and prints a
// per-strategy performance report.
//   pnpm backtest -- --symbols=BTCUSDT,ETHUSDT --days=14 --step=5
// Requires network access to Bybit public REST (runs on the VPS or locally).
import { loadRules, loadWatchlist, loadEnv } from "../config.js";
import { runBacktest } from "./engine.js";
import { formatBacktestReport } from "./report.js";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch {}

function arg(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

const WARMUP_DAYS = 3;

async function main() {
  const rules = loadRules();
  const watchlist = loadWatchlist();
  const env = loadEnv();

  const days = Number(arg("days", "14"));
  const stepMin = Number(arg("step", "5"));
  const feePct = Number(arg("fee_pct", "0.11"));
  const slippagePct = Number(arg("slippage_pct", "0.02"));

  const strategy = arg("strategy", "legacy");
  const warmupDays = (strategy === "H18" || strategy === "SMC" || strategy === "SMC_SCALP") ? 30 : 3;

  const enabled = watchlist.assets.filter((a) => a.enabled);
  const symList = (arg("symbols", "") || enabled.map((a) => a.symbol).join(",")).split(",").filter(Boolean);
  const symbols = symList.map((s) => {
    const asset = watchlist.assets.find((a) => a.symbol === s);
    return { symbol: s, minConfidence: asset?.min_confidence ?? watchlist.global.min_confidence };
  });

  const endMs = Date.now();
  const startMs = endMs - (days + warmupDays) * 86_400_000;

  logger.info(`[backtest] ${symList.join(",")} · ${days}d (+${warmupDays}d warmup) · step ${stepMin}m · category=${env.bybitCategory} · strategy=${strategy}`);

  const trades = await runBacktest({
    rules,
    global: watchlist.global,
    symbols,
    category: env.bybitCategory,
    startMs,
    endMs,
    stepMin,
    costs: { feePct, slippagePct },
    strategy,
    onProgress: (sym, n) => logger.info(`[backtest] ${sym}: ${n} signals`),
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(trades, null, 2));
  } else {
    console.log("\n" + formatBacktestReport(trades, { windowDays: days, stepMin, symbols: symList, feePct, slippagePct }));
  }
  process.exit(0);
}

main().catch((e) => {
  logger.error(`[backtest] failed: ${(e as Error).message}`);
  process.exit(1);
});
