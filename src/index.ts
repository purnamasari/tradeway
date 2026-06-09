// Entry point. Loads config, wires dependencies, and runs the scanner either
// once (--once) or on a per-asset interval loop.
// In loop mode with DB: also runs a 1-minute outcome evaluator.
import { loadWatchlist, loadRules, loadEnv, type AssetConfig } from "./config.js";
import { createCache } from "./cache.js";
import { createDb } from "./db/index.js";
import { createNotifier, formatStatus, formatRunning, formatTradeDetails } from "./notify.js";
import { scanSymbol, type ScannerDeps, type ContextProvider } from "./scanner.js";
import { buildMarketContext } from "./data/market.js";
import { buildMockContext } from "./data/mock.js";
import {
  runRetentionCleanup,
  fetchOpenOutcomes,
  fetchSignalById,
  setSignalDecision,
  createOutcome,
  fetchOpenOutcomeForSymbol,
  fetchOutcomeById,
  fetchSignalAlertRef,
} from "./db/accumulate.js";
import { reconcilePositions } from "./positions/reconciler.js";
import { runHistoricalBackfill, bootstrapHistoryIfNeeded } from "./backfill/history-backfill.js";
import { evaluateOutcomes, type PriceFetcher } from "./outcome/outcome-tracker.js";
import { monitorEdges } from "./lifecycle/monitor.js";
import { fetchTicker } from "./data/bybit.js";
import { MarketFeed } from "./data/ws-feed.js";
import { startScheduler, type PeriodicTask } from "./queue/scheduler.js";
import { buildAnalyticsReport, formatReportText, formatDigest } from "./analytics/report.js";
import { logger } from "./logger.js";
import { startHealthServer, setAnalyticsProvider } from "./health.js";
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

/** Parse `--days=N`, falling back to the configured default. */
function parseDaysArg(fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith("--days="));
  if (!arg) return fallback;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const once = process.argv.includes("--once");
  const mock = process.argv.includes("--mock");
  const backfillOnly = process.argv.includes("--backfill");
  const analyticsOnly = process.argv.includes("--analytics");
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

  const enabled = watchlist.assets.filter((a) => a.enabled);
  const backfillSymbols = enabled.map((a) => a.symbol);

  logger.info(
    `[boot] tradeaway · ${enabled.length} symbols · category=${env.bybitCategory} · ${once ? "single pass" : "loop mode"}${mock ? ` · MOCK DATA (${mockScenario})` : ""}`,
  );
  logger.info(
    `[boot] AI=${env.geminiApiKey ? "gemini+fallback" : "rule-fallback"} · alerts=${env.telegramBotToken ? "telegram" : "console"} · db=${env.databaseUrl ? "postgres" : "disabled"}`,
  );

  // Decide the market-data source up front. The streamed feed needs the global
  // WebSocket (Node >= 21); if it's missing, degrade to REST instead of crashing.
  let useWs = !mock && env.marketFeed === "ws";
  if (useWs && typeof WebSocket === "undefined") {
    logger.warn("[boot] global WebSocket unavailable (needs Node >= 21) — falling back to MARKET_FEED=rest");
    useWs = false;
  }
  let feed: MarketFeed | null = null;

  // ── Health server (started FIRST, before ANY network-touching await) ──────────
  // Bind /health *before* createCache/createDb/createNotifier and before slow boot
  // work (history bootstrap, WS REST-seeding). A hung Redis/Postgres connect or a
  // slow seed must not stop the endpoint from answering the deploy health gate,
  // PM2-external monitoring, and cron checks. The dependency booleans below come
  // from config (env), not the live clients, so they're known this early. One-shot
  // modes (--once/--backfill) exit on their own and need no health server.
  const info = buildInfo();
  if (!once && !backfillOnly && !analyticsOnly && env.healthPort > 0) {
    const maxIntervalMs = Math.max(...enabled.map((a) => a.scan_interval)) * 60_000;
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
        // Track feed liveness only in WS mode. Reads `feed` once assigned below; a
        // null feed (not yet started, or REST fallback) reports connected so it
        // never trips a false 503.
        feedStatus: useWs
          ? () => (feed ? feed.health() : { connected: true, symbols: [] })
          : undefined,
        analyticsDefaultDays: rules.analytics.default_window_days,
      },
      env.healthPort,
      env.healthHost,
    );
  }

  // ── Dependencies (may touch the network) ──────────────────────────────────────
  // createCache opens a Redis connection; createNotifier inits the Telegram bot.
  // These run AFTER the health server is listening, so a slow or hung connect can
  // no longer make the process look dead to the deploy gate.
  const cache = await createCache(env.redisUrl);
  const db = await createDb(env.databaseUrl);
  const notifier = await createNotifier(env);

  // Expose analytics over GET /analytics once the DB is available.
  if (db) setAnalyticsProvider((days) => buildAnalyticsReport(db, days));

  // ── Analytics report (`--analytics [--days=N]`): print and exit. ──────────
  if (analyticsOnly) {
    if (!db) {
      logger.error("[boot] --analytics requires DATABASE_URL");
      process.exit(1);
    }
    const days = parseDaysArg(rules.analytics.default_window_days);
    const report = await buildAnalyticsReport(db, days);
    console.log(formatReportText(report));
    // The Postgres pool keeps the event loop alive; this is a one-shot report, so exit.
    process.exit(0);
  }

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

  const getContext: ContextProvider = mock
    ? (symbol, category) => buildMockContext(symbol, category, mockScenario)
    : buildMarketContext;

  const deps: ScannerDeps = { cache, db, notifier, rules, global: watchlist.global, env, getContext };

  if (once) {
    if (db) await bootstrapHistoryIfNeeded(db, env.bybitCategory, backfillSymbols, rules);
    for (const asset of enabled) {
      await scanSymbol(asset, deps);
    }
    logger.info("[boot] Single pass complete");
    return;
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

  // ── Slow boot work (health endpoint is already serving) ───────────────────────
  // Backfill symbols lacking history, then an immediate retention pass. On a fresh
  // DB the backfill can take a while — fine now that /health is already up.
  if (db) {
    await bootstrapHistoryIfNeeded(db, env.bybitCategory, backfillSymbols, rules);
    void runRetentionCleanup(db, rules);
  }

  // ── WebSocket market feed ─────────────────────────────────────────────────────
  // Streams candles/ticker into in-memory buffers so scans read current data
  // instantly. A start failure degrades to REST polling rather than taking down
  // the process (the default getContext stays buildMarketContext).
  if (useWs) {
    try {
      feed = new MarketFeed(enabled.map((a) => a.symbol), env.bybitCategory);
      await feed.start();
      deps.getContext = (symbol) => feed!.getContext(symbol);
      logger.info("[boot] market feed: websocket (streamed candles + ticker)");
    } catch (err) {
      logger.warn(`[boot] websocket feed failed to start (${(err as Error).message}) — falling back to REST`);
      feed = null;
    }
  } else if (!mock) {
    logger.info("[boot] market feed: rest (per-scan polling)");
  }

  // ── Recurring work ────────────────────────────────────────────────────────────
  // Every periodic job is expressed once as a task; the scheduler runs them on
  // BullMQ when Redis is configured, else on a setInterval fallback.
  const tasks: PeriodicTask[] = [];

  // Per-symbol scans — fire at boot (after jitter), then every scan_interval.
  for (const asset of enabled) {
    tasks.push({
      name: `scan:${asset.symbol}`,
      everyMs: asset.scan_interval * 60_000,
      runAtBoot: true,
      jitterMs: 10_000,
      run: async () => {
        await scanSymbol(asset, deps);
      },
    });
  }

  // Funding/OI history refresh (WS mode only; REST mode fetches it per scan).
  if (feed) {
    const f = feed;
    tasks.push({
      name: "poll:derived",
      everyMs: 5 * 60_000,
      run: async () => {
        for (const asset of enabled) await f.refreshDerived(asset.symbol);
      },
    });
  }

  // Outcome evaluation (60s) + daily retention — only with a database.
  if (db) {
    const database = db;
    const category = env.bybitCategory;
    const priceFetcher: PriceFetcher = async (symbol) => {
      // Prefer the streamed price; fall back to a REST ticker if the feed has no
      // value yet (or isn't running).
      const streamed = feed?.lastPrice(symbol);
      if (streamed != null) return streamed;
      const ticker = await fetchTicker(symbol, category);
      return ticker.lastPrice;
    };
    tasks.push({
      name: "outcome",
      everyMs: 60_000,
      run: () => evaluateOutcomes(database, priceFetcher, notifier),
    });
    // Edge lifecycle monitor (60s) — recomputes each open signal's edge and sends
    // updates instead of duplicate signals. Independent of the price tracker above.
    tasks.push({
      name: "edge",
      everyMs: 60_000,
      run: () =>
        monitorEdges({
          db: database,
          // Live reference so a WS-feed swap of getContext is always picked up.
          getContext: (s, c) => deps.getContext(s, c),
          category,
          cache,
          rules,
          env,
          notifier,
        }),
    });
    // Bybit position reconciler (60s) — autodetect & track real open positions when
    // read-only API keys are configured. READ-ONLY: observes positions, never trades.
    if (env.bybitApiKey && env.bybitApiSecret) {
      const creds = { apiKey: env.bybitApiKey, apiSecret: env.bybitApiSecret };
      logger.info("[boot] bybit position autodetect: enabled (read-only)");
      tasks.push({
        name: "positions",
        everyMs: 60_000,
        runAtBoot: true,
        run: () =>
          reconcilePositions({ db: database, creds, category, fetchPrice: priceFetcher, notifier }),
      });
    }
    tasks.push({
      name: "retention",
      everyMs: 24 * 60 * 60 * 1000,
      run: () => runRetentionCleanup(database, rules),
    });
    // Scheduled analytics digest to Telegram/console (weekly by default; 0 disables).
    if (rules.analytics.digest_every_hours > 0) {
      tasks.push({
        name: "digest",
        everyMs: rules.analytics.digest_every_hours * 60 * 60 * 1000,
        run: async () => {
          const report = await buildAnalyticsReport(database, rules.analytics.digest_window_days);
          await notifier.sendDigest(formatDigest(report));
        },
      });
    }

    // Inbound Telegram commands (no-op on the console notifier). Replies are built
    // from the DB here so notify.ts stays free of db/analytics imports.
    notifier.startCommands({
      analytics: async (days) => {
        const report = await buildAnalyticsReport(database, days ?? rules.analytics.default_window_days);
        return formatDigest(report);
      },
      status: async () => formatStatus(await fetchOpenOutcomes(database, { followedOnly: true })),
      // /running covers everything tracked: followed signals AND autodetected Bybit
      // positions (both are followed=true), so one fetch returns the full list.
      running: async () => formatRunning(await fetchOpenOutcomes(database, { followedOnly: true })),
      onDetails: async (outcomeId) => {
        const row = await fetchOutcomeById(database, outcomeId);
        return row ? formatTradeDetails(row) : "Trade not found.";
      },
      scan: async (symbol) => {
        const asset: AssetConfig =
          enabled.find((a) => a.symbol === symbol) ??
          watchlist.assets.find((a) => a.symbol === symbol) ??
          { symbol, enabled: true, scan_interval: 0, asset_class: "manual" };
        return scanSymbol(asset, deps);
      },
      onFollow: async (signalId) => {
        if (!(await setSignalDecision(database, signalId, "followed"))) return "Already decided.";
        const signal = await fetchSignalById(database, signalId);
        if (!signal) return "Signal not found.";
        if (await fetchOpenOutcomeForSymbol(database, signal.symbol)) {
          return `Already an active signal for ${signal.symbol}.`;
        }
        // Reuse the original alert message so edge updates edit it in place (no spam).
        const ref = await fetchSignalAlertRef(database, signalId);
        await createOutcome(database, signal, signalId, true, ref);
        return `✅ Following ${signal.symbol} ${signal.direction.toUpperCase()} ${signal.strategy}`;
      },
      onSkip: async (signalId) => {
        if (!(await setSignalDecision(database, signalId, "skipped"))) return "Already decided.";
        const signal = await fetchSignalById(database, signalId);
        if (!signal) return "Skipped.";
        await createOutcome(database, signal, signalId, false); // shadow outcome
        return `⏭ Skipped ${signal.symbol} ${signal.direction.toUpperCase()}`;
      },
    });
  }

  const scheduler = await startScheduler(env.redisUrl, tasks);
  logger.info(`[boot] scheduler=${scheduler.kind} · ${tasks.length} tasks`);

  const shutdown = (signal: string) => {
    logger.info(`[boot] ${signal} — shutting down`);
    void scheduler.stop();
    void notifier.stopCommands();
    feed?.stop();
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
