import postgres from "postgres";
process.loadEnvFile(new URL("../.env", import.meta.url));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

async function main() {
  // Real Bybit trades: entry vs... no exit price column for CLOSED; check hit_price + mgmt events pnl
  const trades = await sql`
    select o.id, o.symbol, o.direction, o.entry_price, o.sl, o.tp, o.hit_price,
           o.opened_at, o.closed_at, o.duration_ms, o.status, o.source, o.strategy,
           o.original_factors->>'size' as size,
           (select e.pnl_pct from trade_management_events e
             where e.outcome_id = o.id and e.pnl_pct is not null
             order by e.recorded_at desc limit 1) as last_pnl_pct
    from signal_outcomes o
    where o.status in ('TP_HIT','SL_HIT','EXPIRED','CLOSED')
    order by o.closed_at`;
  console.log(JSON.stringify(trades, null, 1));
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
