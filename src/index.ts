// Entry point. Loads config, wires dependencies, and runs the scanner either
// once (--once) or on a per-asset interval loop.
import { loadWatchlist, loadRules, loadEnv } from "./config.js";
import { createCache } from "./cache.js";
import { createNotifier } from "./notify.js";
import { scanSymbol, type ScannerDeps, type ContextProvider } from "./scanner.js";
import { buildMarketContext } from "./data/market.js";
import { buildMockContext } from "./data/mock.js";
import { logger } from "./logger.js";

// Load .env if present (Node 22 builtin; no dependency).
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file — fine, everything is optional
}

async function main() {
  const once = process.argv.includes("--once");
  const mock = process.argv.includes("--mock");
  const watchlist = loadWatchlist();
  const rules = loadRules();
  const env = loadEnv();

  const cache = await createCache(env.redisUrl);
  const notifier = await createNotifier(env);
  const getContext: ContextProvider = mock ? buildMockContext : buildMarketContext;

  const deps: ScannerDeps = { cache, notifier, rules, global: watchlist.global, env, getContext };
  const enabled = watchlist.assets.filter((a) => a.enabled);

  logger.info(
    `[boot] tradeaway · ${enabled.length} symbols · category=${env.bybitCategory} · ${once ? "single pass" : "loop mode"}${mock ? " · MOCK DATA" : ""}`,
  );
  logger.info(
    `[boot] AI=${env.geminiApiKey ? "gemini+fallback" : "rule-fallback"} · alerts=${env.telegramBotToken ? "telegram" : "console"}`,
  );

  if (once) {
    for (const asset of enabled) {
      await scanSymbol(asset, deps);
    }
    logger.info("[boot] Single pass complete");
    return;
  }

  // Per-asset interval loop with startup jitter so symbols don't fire together.
  for (const asset of enabled) {
    const intervalMs = asset.scan_interval * 60_000;
    const jitter = Math.floor(Math.random() * 10_000);
    setTimeout(() => {
      void scanSymbol(asset, deps);
      setInterval(() => void scanSymbol(asset, deps), intervalMs);
    }, jitter);
    logger.info(`[boot] scheduled ${asset.symbol} every ${asset.scan_interval}m (jitter ${jitter}ms)`);
  }

  process.on("SIGINT", () => {
    logger.info("[boot] shutting down");
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`[boot] fatal: ${(err as Error).message}`);
  process.exit(1);
});
