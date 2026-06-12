import postgres from "postgres";
process.loadEnvFile(new URL("../.env", import.meta.url));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
async function main() {
  const mh = await sql`select symbol, count(*) n,
      min(timestamp) earliest, max(timestamp) latest,
      count(open) candles, count(open_interest) oi, count(funding_rate) funding
    from market_history group by symbol order by symbol`;
  console.log("market_history:"); console.table(mh);
  const sig = await sql`select strategy, count(*) n, min(detected_at) earliest, max(detected_at) latest from signals group by strategy`;
  console.log("signals:"); console.table(sig);
  const oc = await sql`select status, source, followed, count(*) n from signal_outcomes group by status, source, followed order by n desc`;
  console.log("signal_outcomes:"); console.table(oc);
  const met = await sql`select count(*) n, min(recorded_at) earliest, max(recorded_at) latest from metric_history`;
  console.table(met);
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
