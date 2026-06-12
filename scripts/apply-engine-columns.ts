// One-shot: apply MIGRATION_PLAN Phase-2 additive columns (drizzle-kit push
// hangs on introspection in this environment; these are the exact statements
// it would emit — all additive + idempotent).
import postgres from "postgres";
process.loadEnvFile(new URL("../.env", import.meta.url));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const cols: Array<[string, string]> = [
  ["strategy_state", "jsonb"],
  ["entry_reasons", "jsonb"],
  ["qty", "real"],
  ["risk_amount", "real"],
  ["risk_model", "text"],
  ["age_bars", "integer"],
  ["exit_reason", "text"],
  ["max_hold_sec", "integer"],
];
for (const [name, type] of cols) {
  await sql.unsafe(`ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  console.log(`ok: ${name} ${type}`);
}
const check = await sql`select column_name from information_schema.columns
  where table_name = 'signal_outcomes' and column_name in ('strategy_state','entry_reasons','qty','risk_amount','risk_model','age_bars','exit_reason','max_hold_sec')`;
console.log(`verified ${check.length}/8 columns present`);
await sql.end();
