// EXPLORATION (not a hypothesis): BTC intraday/weekly seasonality on the
// 2023-01..2025-02 epoch ONLY. The 2025-03..2026-05 window stays untouched as
// the validation set for anything registered from this.
//   pnpm exec tsx research/explore-seasonality.ts
import { loadSymbolCache } from "./harness.js";

const { candles15m: c } = loadSymbolCache("BN23_BTCUSDT");

// Mean 1h-forward log return by UTC hour-of-day, split by calendar year to
// check stability inside the exploration window itself.
function hourTable(fromYear: number, toYear: number): number[] {
  const sum = new Array<number>(24).fill(0);
  const n = new Array<number>(24).fill(0);
  for (let i = 0; i + 4 < c.length; i++) {
    const y = new Date(c[i]!.time * 1000).getUTCFullYear();
    if (y < fromYear || y > toYear) continue;
    const bar = c[i]!;
    if ((bar.time + 900) % 3600 !== 0) continue; // hour boundary close
    const hour = ((bar.time + 900) % 86400) / 3600;
    const r = Math.log(c[i + 4]!.close / bar.close);
    sum[hour]! += r;
    n[hour]!++;
  }
  return sum.map((s, h) => (n[h]! ? (s / n[h]!) * 1e4 : 0)); // bps per hour-slot
}

const t23 = hourTable(2023, 2023);
const t24 = hourTable(2024, 2025);
console.log("UTC hour | 2023 (bps/1h) | 2024-25Q1 (bps/1h) | same sign");
for (let h = 0; h < 24; h++) {
  const a = t23[h]!;
  const b = t24[h]!;
  console.log(`${String(h).padStart(2)}       | ${a.toFixed(2).padStart(8)} | ${b.toFixed(2).padStart(8)} | ${Math.sign(a) === Math.sign(b) ? "YES" : "no"}`);
}

// Day-of-week (UTC), mean 24h-forward log return from 00:00 close.
const dsum = new Array<number>(7).fill(0);
const dn = new Array<number>(7).fill(0);
for (let i = 0; i + 96 < c.length; i++) {
  const bar = c[i]!;
  if ((bar.time + 900) % 86400 !== 0) continue;
  const dow = new Date((bar.time + 900) * 1000).getUTCDay();
  dsum[dow]! += Math.log(c[i + 96]!.close / bar.close);
  dn[dow]!++;
}
console.log("\nDOW (0=Sun) | mean 24h fwd (bps)");
for (let d = 0; d < 7; d++) console.log(`${d}           | ${((dsum[d]! / dn[d]!) * 1e4).toFixed(1)}`);
