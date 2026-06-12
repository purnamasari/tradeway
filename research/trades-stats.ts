import postgres from "postgres";
process.loadEnvFile(new URL("../.env", import.meta.url));
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

interface Row { symbol: string; direction: string; entry_price: number; sl: number; tp: number; hit_price: number | null; status: string; source: string; strategy: string; opened_at: Date; closed_at: Date; }

async function main() {
  const rows = await sql<Row[]>`
    select symbol, direction, entry_price, sl, tp, hit_price, status, source, strategy, opened_at, closed_at
    from signal_outcomes where status in ('TP_HIT','SL_HIT','EXPIRED','CLOSED') order by closed_at`;

  const groups: Record<string, Row[]> = {};
  for (const r of rows) groups[`${r.source}/${r.strategy}`] = [...(groups[`${r.source}/${r.strategy}`] ?? []), r];

  for (const [g, rs] of Object.entries(groups)) {
    let sumPct = 0, sumR = 0, nR = 0, wins = 0, losses = 0, flat = 0;
    for (const r of rs) {
      if (r.hit_price == null) { flat++; continue; }
      const sign = r.direction === "long" ? 1 : -1;
      const pct = sign * (r.hit_price - r.entry_price) / r.entry_price * 100;
      sumPct += pct;
      const risk = Math.abs(r.entry_price - r.sl);
      if (risk > 0 && r.sl !== 0) { sumR += sign * (r.hit_price - r.entry_price) / risk; nR++; }
      if (pct > 0.05) wins++; else if (pct < -0.05) losses++; else flat++;
    }
    console.log(`${g}: n=${rs.length} wins=${wins} losses=${losses} flat/na=${flat} sumPnl%=${sumPct.toFixed(2)} avgPnl%=${(sumPct/(rs.length-0)).toFixed(3)} sumR=${sumR.toFixed(2)} avgR=${nR?(sumR/nR).toFixed(3):"-"} (n_R=${nR})`);
  }
  await sql.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
