// Health/liveness server. Dependency-free (Node built-in http).
//
// The bot is a long-running worker with no HTTP surface, so "is the process up?"
// (which PM2 already answers) is not enough — a process can be alive but stuck,
// erroring every scan, or wedged on a hung request. This module tracks per-symbol
// scan heartbeats and exposes GET /health so an external uptime monitor, a cron
// check, or the CD pipeline can verify the bot is actually *working*, not just
// running.
//
// Returns 200 while healthy (or still within the startup grace period) and 503
// once any symbol's scans go stale, so HTTP-aware monitors flag it automatically.
import { createServer, type Server } from "node:http";
import { logger } from "./logger.js";

interface SymbolHealth {
  lastSuccess: number | null;
  lastError: number | null;
  lastErrorMsg: string | null;
  successCount: number;
  errorCount: number;
}

/** Liveness snapshot from the WebSocket feed, if one is running. */
export interface FeedStatus {
  connected: boolean;
  symbols: Array<{ symbol: string; lastKlineAgoMs: number | null }>;
}

interface HealthConfig {
  version: string;
  commit: string;
  symbols: string[];
  /** Longest configured scan interval (ms). Staleness is judged against this. */
  maxIntervalMs: number;
  db: boolean;
  redis: boolean;
  telegram: boolean;
  ai: boolean;
  /** Optional WS-feed liveness provider; absent when running in REST mode. */
  feedStatus?: () => FeedStatus;
}

const startedAt = Date.now();
const symbolHealth = new Map<string, SymbolHealth>();
let config: HealthConfig | null = null;

function entryFor(symbol: string): SymbolHealth {
  let e = symbolHealth.get(symbol);
  if (!e) {
    e = { lastSuccess: null, lastError: null, lastErrorMsg: null, successCount: 0, errorCount: 0 };
    symbolHealth.set(symbol, e);
  }
  return e;
}

/** Called by the scanner after a symbol completes a full pass without throwing. */
export function recordScanSuccess(symbol: string): void {
  const e = entryFor(symbol);
  e.lastSuccess = Date.now();
  e.successCount++;
}

/** Called by the scanner when a symbol's scan throws. */
export function recordScanError(symbol: string, message: string): void {
  const e = entryFor(symbol);
  e.lastError = Date.now();
  e.lastErrorMsg = message;
  e.errorCount++;
}

/**
 * A symbol is stale when no successful scan has landed within two intervals plus
 * a 2-minute buffer — but only after the process has been up that long, so a
 * fresh boot doesn't report unhealthy before the first scans complete.
 */
function stalenessThresholdMs(): number {
  const max = config?.maxIntervalMs ?? 10 * 60_000;
  return max * 2 + 120_000;
}

function buildReport() {
  const now = Date.now();
  const uptimeMs = now - startedAt;
  const threshold = stalenessThresholdMs();
  const grace = uptimeMs < threshold;

  const symbols = (config?.symbols ?? [...symbolHealth.keys()]).map((symbol) => {
    const e = symbolHealth.get(symbol);
    const lastSuccessAgoMs = e?.lastSuccess ? now - e.lastSuccess : null;
    // Stale only once past the grace window: never scanned, or scanned too long ago.
    const stale = !grace && (lastSuccessAgoMs === null || lastSuccessAgoMs > threshold);
    return {
      symbol,
      stale,
      lastSuccessAgoMs,
      lastErrorAgoMs: e?.lastError ? now - e.lastError : null,
      lastErrorMsg: e?.lastErrorMsg ?? null,
      successCount: e?.successCount ?? 0,
      errorCount: e?.errorCount ?? 0,
    };
  });

  const staleSymbols = symbols.filter((s) => s.stale).map((s) => s.symbol);

  // A disconnected WebSocket feed means scans may be reading stale buffers while
  // still "succeeding" — so it must drag health down independently of heartbeats.
  const feed = config?.feedStatus?.();
  const feedDown = !grace && feed !== undefined && !feed.connected;

  const status = grace ? "starting" : staleSymbols.length > 0 || feedDown ? "unhealthy" : "ok";
  const mem = process.memoryUsage();

  return {
    status,
    version: config?.version ?? "unknown",
    commit: config?.commit ?? "unknown",
    pid: process.pid,
    uptimeSec: Math.floor(uptimeMs / 1000),
    staleSymbols,
    feed: feed ?? null,
    dependencies: {
      db: config?.db ?? false,
      redis: config?.redis ?? false,
      telegram: config?.telegram ?? false,
      ai: config?.ai ?? false,
    },
    memoryMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    },
    symbols,
    timestamp: new Date(now).toISOString(),
  };
}

/**
 * Starts the health HTTP server. Binds to 127.0.0.1 by default so the endpoint is
 * only reachable from the box (front it with a reverse proxy or SSH tunnel to
 * expose it). Returns the server so callers can close it on shutdown.
 */
export function startHealthServer(cfg: HealthConfig, port: number, host: string): Server {
  config = cfg;

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/health" || url === "/healthz" || url === "/") {
      const report = buildReport();
      const code = report.status === "unhealthy" ? 503 : 200;
      const body = JSON.stringify(report, null, 2);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.on("error", (err) => {
    logger.error(`[health] server error: ${err.message}`);
  });

  server.listen(port, host, () => {
    logger.info(`[health] listening on http://${host}:${port}/health`);
  });

  return server;
}
