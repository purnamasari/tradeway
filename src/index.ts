// Entry point. Loads config, wires dependencies, and runs the scanner either
// once (--once) or on a per-asset interval loop.
// In loop mode with DB: also runs a 1-minute outcome evaluator.
import { loadWatchlist, loadRules, loadEnv } from "./config.js";
import { createCache } from "./cache.js";
import { createDb } from "./db/index.js";
import { createNotifier } from "./notify.js";
import { scanSymbol, type ScannerDeps, type ContextProvider } from "./scanner.js";
import { buildMarketContext } from "./data/market.js";
import { buildMockContext } from "./data/mock.js";
import { runRetentionCleanup } from "./db/accumulate.js";
import { runHistoricalBackfill, bootstrapHistoryIfNeeded } from "./backfill/history-backfill.js";
import { evaluateOutcomes, type PriceFetcher } from "./outcome/outcome-tracker.js";
import { fetchTicker } from "./data/bybit.js";
import { logger } from "./logger.js";
import { startHealthServer } from "./health.js";
import { readFileSync } from "node:fs";
import type { MockScenario } from "./types.js";

// Build metadata for the health endpoint. Version comes from package.json; the
// git commit is injected by the deploy script (scripts/deploy.sh) so /health can
// report exactly which revision is live.
function buildInfo(): { version: string; commit: string } {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    version = pkg.version ?? "unknown";
  } catch {
    // ignore — version is best-effort
  }
  return { version, commit: process.env.GIT_COMMIT || "unknown" };
}

// Load .env if present (Node 22 builtin; no dependency).
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file — fine, everything is optional
}

function parseMockScenario(): MockScenario {
  const arg = process.argv.find((a) => a.startsWith("--mock-scenario="));
  if (!arg) return "sweep";
  const val = arg.split("=")[1] as MockScenario;
  if (val !== "sweep" && val !== "pullback" && val !== "squeeze") {
    logger.warn(`[boot] Unknown mock scenario "${val}", defaulting to "sweep"`);
    return "sweep";
  }
  return val;
}

async function main() {
  const once = process.argv.includes("--once");
  const mock = process.argv.includes("--mock");
  const backfillOnly = process.argv.includes("--backfill");
  const mockScenario = mock ? parseMockScenario() : "sweep";
  const watchlist = loadWatchlist();
  const rules = loadRules();
  const env = loadEnv();

  // In mock mode, force rule-based fallback and skip external services:
  // synthetic candles are crafted for the EMA/ADX classifier, not Gemini.
  if (mock) {
    env.geminiApiKey = undefined;
    env.telegramBotToken = undefined;
    env.telegramChatId = undefined;
    env.redisUrl = undefined;
    env.databaseUrl = undefined;
  }

  const cache = await createCache(env.redisUrl);
  const db = await createDb(env.databaseUrl);
  const notifier = await createNotifier(env);

  const backfillSymbols = watchlist.assets.filter((a) => a.enabled).map((a) => a.symbol);

  // ── Manual one-time backfill (`--backfill`): force a full run, then exit. ──
  if (backfillOnly) {
    if (!db) {
      logger.error("[boot] --backfill requires DATABASE_URL");
      process.exit(1);
    }
    logger.info(`[boot] historical backfill · ${backfillSymbols.length} symbols · category=${env.bybitCategory}`);
    await runHistoricalBackfill(db, env.bybitCategory, backfillSymbols, rules);
    return;
  }

  // ── Startup bootstrap: backfill symbols that lack sufficient history. ──────
  if (db && !mock) {
    await bootstrapHistoryIfNeeded(db, env.bybitCategory, backfillSymbols, rules);
  }

  if (db && !mock) {
    void runRetentionCleanup(db, rules);
    if (!once) {
      setInterval(() => void runRetentionCleanup(db, rules), 24 * 60 * 60 * 1000);
    }
  }

  const getContext: ContextProvider = mock
    ? (symbol, category) => buildMockContext(symbol, category, mockScenario)
    : buildMarketContext;

  const deps: ScannerDeps = { cache, db, notifier, rules, global: watchlist.global, env, getContext };
  const enabled = watchlist.assets.filter((a) => a.enabled);

  logger.info(
    `[boot] tradeaway · ${enabled.length} symbols · category=${env.bybitCategory} · ${once ? "single pass" : "loop mode"}${mock ? ` · MOCK DATA (${mockScenario})` : ""}`,
  );
  logger.info(
    `[boot] AI=${env.geminiApiKey ? "gemini+fallback" : "rule-fallback"} · alerts=${env.telegramBotToken ? "telegram" : "console"} · db=${env.databaseUrl ? "postgres" : "disabled"}`,
  );

  if (once) {
    for (const asset of enabled) {
      await scanSymbol(asset, deps);
    }
    logger.info("[boot] Single pass complete");
    return;
  }

  // ── Health server ───────────────────────────────────────────────────────────
  // Loop mode only: exposes /health for PM2-external monitoring, the CD health
  // gate, and cron checks. Staleness is judged against the longest scan interval.
  const maxIntervalMs = Math.max(...enabled.map((a) => a.scan_interval)) * 60_000;
  const info = buildInfo();
  if (env.healthPort > 0) {
    startHealthServer(
      {
        version: info.version,
        commit: info.commit,
        symbols: enabled.map((a) => a.symbol),
        maxIntervalMs,
        db: Boolean(env.databaseUrl),
        redis: Boolean(env.redisUrl),
        telegram: Boolean(env.telegramBotToken),
        ai: Boolean(env.geminiApiKey),
      },
      env.healthPort,
      env.healthHost,
    );
  }

  // ── Crash & shutdown monitoring ───────────────────────────────────────────────
  // A long-running worker should report when it dies so a stuck/looping restart is
  // visible. We notify, then exit non-zero and let PM2 restart us — alerting but
  // not swallowing the fault.
  if (env.opsAlerts) {
    void notifier.sendOps(
      `🟢 tradeaway started · ${enabled.length} symbols · v${info.version} (${info.commit}) · ` +
        `AI=${env.geminiApiKey ? "gemini" : "rule"} db=${env.databaseUrl ? "on" : "off"}`,
    );
  }
  const onFatal = (label: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`[boot] ${label}: ${msg}`);
    const done = () => process.exit(1);
    if (env.opsAlerts) {
      void notifier.sendOps(`🔴 tradeaway ${label} — restarting\n${(err as Error)?.message ?? err}`).finally(done);
      // Don't hang forever if the alert stalls.
      setTimeout(done, 3000).unref();
    } else {
      done();
    }
  };
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", onFatal("unhandledRejection"));

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

  // ── Outcome evaluator (1-minute polling) ────────────────────────────────────
  // Only runs in loop mode with a database and live price feed.
  if (db && !mock) {
    const category = env.bybitCategory;
    const priceFetcher: PriceFetcher = async (symbol) => {
      const ticker = await fetchTicker(symbol, category);
      return ticker.lastPrice;
    };

    // Initial check after 30s (give scanners time to produce signals first).
    setTimeout(() => {
      void evaluateOutcomes(db, priceFetcher, notifier);
    }, 30_000);

    // Then every 60s.
    setInterval(() => {
      void evaluateOutcomes(db, priceFetcher, notifier);
    }, 60_000);

    logger.info("[boot] outcome tracker: every 60s");
  }

  const shutdown = (signal: string) => {
    logger.info(`[boot] ${signal} — shutting down`);
    const done = () => process.exit(0);
    if (env.opsAlerts) {
      void notifier.sendOps(`🟡 tradeaway stopping (${signal})`).finally(done);
      setTimeout(done, 3000).unref();
    } else {
      done();
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(`[boot] fatal: ${(err as Error).message}`);
  process.exit(1);
});
