// One-time export: market_history -> research/data/<symbol>.json
// { candles15m: Candle[], oi: {time,openInterest}[], funding: {time,fundingRate}[] }
import postgres from "postgres";
import { writeFileSync } from "node:fs";
process.loadEnvFile(new URL("../.env", import.meta.url));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT", "ZECUSDT"];

async function main() {
  for (const sym of SYMBOLS) {
    const rows = await sql`
      select extract(epoch from timestamp)::bigint as t, open, high, low, close, volume, open_interest, funding_rate
      from market_history where symbol = ${sym} order by timestamp asc`;
    const candles15m = [], oi = [], funding = [];
    for (const r of rows) {
      const time = Number(r.t);
      if (r.open != null) candles15m.push({ time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 });
      if (r.open_interest != null) oi.push({ time, openInterest: r.open_interest });
      if (r.funding_rate != null) funding.push({ time, fundingRate: r.funding_rate });
    }
    writeFileSync(new URL(`./data/${sym}.json`, import.meta.url), JSON.stringify({ candles15m, oi, funding }));
    console.log(`${sym}: ${candles15m.length} candles, ${oi.length} oi, ${funding.length} funding`);
    // gap check
    let gaps = 0, maxGap = 0;
    for (let i = 1; i < candles15m.length; i++) {
      const d = candles15m[i].time - candles15m[i-1].time;
      if (d !== 900) { gaps++; maxGap = Math.max(maxGap, d); }
    }
    console.log(`  gaps!=15m: ${gaps}, max gap ${maxGap}s`);
  }
  await sql.end();
}
main().catch(e => { console.error(e); process.exit(1); });
