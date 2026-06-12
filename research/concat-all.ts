// Concatenate BN23_<sym> + BN_<sym> caches into BNALL_<sym> for every symbol
// that has both (HYPE only has the recent window and is skipped).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SymbolCache } from "./harness.js";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ZECUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT"];
for (const s of SYMS) {
  const pa = fileURLToPath(new URL(`./data/BN23_${s}.json`, import.meta.url));
  const pb = fileURLToPath(new URL(`./data/BN_${s}.json`, import.meta.url));
  if (!existsSync(pa) || !existsSync(pb)) { console.log(`${s}: missing window, skipped`); continue; }
  const a = JSON.parse(readFileSync(pa, "utf8")) as SymbolCache;
  const b = JSON.parse(readFileSync(pb, "utf8")) as SymbolCache;
  const seen = new Set(a.candles15m.map((c) => c.time));
  const candles15m = [...a.candles15m, ...b.candles15m.filter((c) => !seen.has(c.time))].sort((x, y) => x.time - y.time);
  const funding = [...a.funding, ...b.funding].sort((x, y) => x.time - y.time);
  let gaps = 0;
  for (let i = 1; i < candles15m.length; i++) if (candles15m[i]!.time - candles15m[i - 1]!.time !== 900) gaps++;
  writeFileSync(new URL(`./data/BNALL_${s}.json`, import.meta.url), JSON.stringify({ candles15m, oi: [], funding }));
  console.log(`BNALL_${s}: ${candles15m.length} candles, ${gaps} gaps`);
}
