// Historical candle backfill CLI.
//   pnpm fetch:history BTCUSDT                 — one symbol, all timeframes
//   pnpm fetch:history BTCUSDT ETHUSDT SOLUSDT — several symbols
//   pnpm fetch:history --all                   — every enabled watchlist symbol
// Options:
//   --days=480       target history depth (default 480 — covers H18's 30d
//                    warmup with multi-year headroom for validation)
//   --tf=15m,1h      restrict timeframes (default: 15m,1h,4h,1d)
//   --repair         also detect and re-fetch internal gaps
// Safe to interrupt and re-run: every run resumes from what the DB has.
import { loadEnv, loadWatchlist } from "../config.js";
import { createDb } from "../db/index.js";
import { backfillSeries, HISTORY_TIMEFRAMES } from "../data/history/backfill.js";
import type { Timeframe } from "../types.js";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch { /* optional */ }

function flag(name: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main() {
  const env = loadEnv();
  const db = await createDb(env.databaseUrl);
  if (!db) {
    logger.error("[history] DATABASE_URL is required for fetch:history");
    process.exit(1);
  }

  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const all = process.argv.includes("--all");
  const symbols = all
    ? loadWatchlist().assets.filter((a) => a.enabled).map((a) => a.symbol)
    : positional;
  if (symbols.length === 0) {
    logger.error("[history] no symbols — pass symbols or --all");
    process.exit(1);
  }

  const days = Number(flag("days") ?? 480);
  const tfs = (flag("tf")?.split(",") as Timeframe[] | undefined) ?? HISTORY_TIMEFRAMES;
  const repairGaps = process.argv.includes("--repair");

  logger.info(`[history] backfill ${symbols.join(",")} · ${tfs.join("/")} · ${days}d${repairGaps ? " · repair" : ""}`);
  let failures = 0;
  for (const symbol of symbols) {
    for (const tf of tfs) {
      try {
        await backfillSeries(db, symbol, tf, env.bybitCategory, { days, repairGaps });
      } catch (err) {
        failures++;
        logger.error(`[history] ${symbol} ${tf} failed: ${(err as Error).message}`);
      }
    }
  }
  logger.info(`[history] done${failures ? ` · ${failures} series FAILED (re-run to resume)` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  logger.error(`[history] fatal: ${(e as Error).message}`);
  process.exit(1);
});
