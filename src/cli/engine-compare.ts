// Engine-vs-legacy comparison report.
//   pnpm engine:compare [--days=30]
// Groups signal_outcomes by source/strategy over the window: volumes,
// terminal-status mix, fill rate, durations — the paper-trading scorecard for
// judging the engine path against the legacy scanner before any cutover.
import { sql } from "drizzle-orm";
import { loadEnv } from "../config.js";
import { createDb } from "../db/index.js";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch { /* optional */ }

async function main() {
  const env = loadEnv();
  const db = await createDb(env.databaseUrl);
  if (!db) {
    logger.error("[compare] DATABASE_URL is required");
    process.exit(1);
  }
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.slice(7)) : 30;

  const rows = await db.execute(sql`
    select source, strategy,
           count(*)::int as total,
           count(*) filter (where status = 'PENDING_ENTRY')::int as pending,
           count(*) filter (where status = 'ACTIVE')::int as active,
           count(*) filter (where status = 'TP_HIT')::int as tp_hit,
           count(*) filter (where status = 'SL_HIT')::int as sl_hit,
           count(*) filter (where status = 'EXPIRED')::int as expired,
           count(*) filter (where status = 'CLOSED')::int as closed,
           count(*) filter (where activated_at is not null)::int as fills,
           round(avg(duration_ms) filter (where duration_ms is not null) / 3600000.0, 1) as avg_hold_h
    from signal_outcomes
    where opened_at >= now() - make_interval(days => ${days})
    group by source, strategy
    order by source, strategy
  `);

  console.log(`signal_outcomes, last ${days}d (engine vs legacy):\n`);
  console.log("source   strategy          total pend actv  tp  sl  exp clsd fills avg_hold_h");
  for (const r of rows as unknown as Array<Record<string, unknown>>) {
    console.log(
      `${String(r.source).padEnd(8)} ${String(r.strategy).padEnd(16)} ${String(r.total).padStart(5)} ` +
        `${String(r.pending).padStart(4)} ${String(r.active).padStart(4)} ${String(r.tp_hit).padStart(3)} ` +
        `${String(r.sl_hit).padStart(3)} ${String(r.expired).padStart(4)} ${String(r.closed).padStart(4)} ` +
        `${String(r.fills).padStart(5)} ${String(r.avg_hold_h ?? "—").padStart(10)}`,
    );
  }
  console.log(
    "\nNotes: source='engine' rows are strategy-engine positions (SL_HIT covers stop AND trail exits,\n" +
      "CLOSED = strategy-defined exit, EXPIRED = entry cancel or max-hold). source='signal' is the\n" +
      "legacy scanner; source='bybit' is reconciled real positions.",
  );
  process.exit(0);
}

main().catch((e) => {
  logger.error(`[compare] fatal: ${(e as Error).message}`);
  process.exit(1);
});
