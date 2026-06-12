// Historical candle coverage report.
//   pnpm verify:history                — every enabled watchlist symbol
//   pnpm verify:history BTCUSDT ETHUSDT
// Reports per (symbol, timeframe): candle count, covered range, completeness,
// internal gaps (with ranges), misaligned bars, and staleness vs now.
// Exit code 1 when any series has gaps/misalignment (CI/cron friendly).
import { loadEnv, loadWatchlist } from "../config.js";
import { createDb } from "../db/index.js";
import { verifySeries, HISTORY_TIMEFRAMES } from "../data/history/backfill.js";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch { /* optional */ }

const day = (sec: number | null): string =>
  sec == null ? "—" : new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ");

async function main() {
  const env = loadEnv();
  const db = await createDb(env.databaseUrl);
  if (!db) {
    logger.error("[verify] DATABASE_URL is required for verify:history");
    process.exit(1);
  }

  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const symbols = positional.length
    ? positional
    : loadWatchlist().assets.filter((a) => a.enabled).map((a) => a.symbol);

  let problems = 0;
  console.log("symbol     tf   count    coverage                              missing gaps misalign lag");
  for (const symbol of symbols) {
    for (const tf of HISTORY_TIMEFRAMES) {
      const r = await verifySeries(db, symbol, tf);
      const cover = r.count === 0 ? "(empty)" : `${day(r.earliest)} .. ${day(r.latest)}`;
      console.log(
        `${symbol.padEnd(10)} ${tf.padEnd(4)} ${String(r.count).padStart(7)} ` +
          `${cover.padEnd(37)} ${String(r.missing).padStart(7)} ${String(r.gaps.length).padStart(4)} ` +
          `${String(r.misaligned).padStart(8)} ${r.lagBars}`,
      );
      for (const gap of r.gaps.slice(0, 5)) {
        console.log(`    gap: ${day(gap.fromSec)} .. ${day(gap.toSec)} (${gap.missingBars} bars)`);
      }
      if (r.gaps.length > 5) console.log(`    … ${r.gaps.length - 5} more gaps`);
      if (r.gaps.length || r.misaligned) problems++;
    }
  }
  if (problems) {
    console.log(`\n${problems} series with problems — run: pnpm fetch:history --all --repair`);
  }
  process.exit(problems ? 1 : 0);
}

main().catch((e) => {
  logger.error(`[verify] fatal: ${(e as Error).message}`);
  process.exit(1);
});
