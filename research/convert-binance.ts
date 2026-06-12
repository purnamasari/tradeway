// Convert Binance monthly dump CSVs (research/binance-raw/) into the
// SymbolCache JSON shape used by the harness.
//   pnpm exec tsx research/convert-binance.ts                      # 2025-03.. window -> BN_<sym>.json
//   pnpm exec tsx research/convert-binance.ts --epoch=23 --symbols=BTCUSDT,...  # 2023-01..2025-02 -> BN23_<sym>.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW = fileURLToPath(new URL("./binance-raw/", import.meta.url));

function arg(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

const epoch = arg("epoch", ""); // "" = 2025-03..2026-05 window; "23" = 2023-01..2025-02
const SYMBOLS = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,HYPEUSDT,ZECUSDT").split(",");
const inEpoch = (ym: string) => (epoch === "23" ? ym >= "2023-01" && ym <= "2025-02" : ym >= "2025-03" && ym <= "2026-05");
const PREFIX = epoch === "23" ? "BN23_" : "BN_";

function parseCsv(path: string): string[][] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d/.test(l)) // skip header lines
    .map((l) => l.split(","));
}

for (const sym of SYMBOLS) {
  const files = readdirSync(RAW)
    .filter((f) => f.startsWith(`${sym}-`) && f.endsWith(".csv"))
    .filter((f) => {
      const m = f.match(/(\d{4}-\d{2})\.csv$/);
      return m ? inEpoch(m[1]!) : false;
    })
    .sort();
  const candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  const funding: Array<{ time: number; fundingRate: number }> = [];
  for (const f of files) {
    const rows = parseCsv(RAW + f);
    if (f.includes("-15m-")) {
      for (const r of rows) {
        candles.push({
          time: Math.floor(Number(r[0]) / 1000),
          open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
    } else if (f.includes("-fundingRate-")) {
      for (const r of rows) {
        funding.push({ time: Math.floor(Number(r[0]) / 1000), fundingRate: Number(r[2]) });
      }
    }
  }
  candles.sort((a, b) => a.time - b.time);
  funding.sort((a, b) => a.time - b.time);
  const c2 = candles.filter((c, i) => i === 0 || c.time !== candles[i - 1]!.time);
  const f2 = funding.filter((c, i) => i === 0 || c.time !== funding[i - 1]!.time);
  let gaps = 0;
  for (let i = 1; i < c2.length; i++) if (c2[i]!.time - c2[i - 1]!.time !== 900) gaps++;
  if (c2.length === 0) { console.log(`${sym}: no data, skipped`); continue; }
  writeFileSync(
    new URL(`./data/${PREFIX}${sym}.json`, import.meta.url),
    JSON.stringify({ candles15m: c2, oi: [], funding: f2 }),
  );
  const span = ((c2.at(-1)!.time - c2[0]!.time) / 86400).toFixed(0);
  console.log(`${PREFIX}${sym}: ${c2.length} candles over ${span}d, ${f2.length} funding events, ${gaps} gaps`);
}
