// Concatenate the two contiguous BTC Binance caches (2023-01..2025-02 and
// 2025-03..2026-05) into one 41-month cache: data/BNALL_BTCUSDT.json.
import { readFileSync, writeFileSync } from "node:fs";
import type { SymbolCache } from "./harness.js";

const a = JSON.parse(readFileSync(new URL("./data/BN23_BTCUSDT.json", import.meta.url), "utf8")) as SymbolCache;
const b = JSON.parse(readFileSync(new URL("./data/BN_BTCUSDT.json", import.meta.url), "utf8")) as SymbolCache;

const seen = new Set(a.candles15m.map((c) => c.time));
const candles15m = [...a.candles15m, ...b.candles15m.filter((c) => !seen.has(c.time))].sort((x, y) => x.time - y.time);
const funding = [...a.funding, ...b.funding].sort((x, y) => x.time - y.time);
let gaps = 0;
for (let i = 1; i < candles15m.length; i++) if (candles15m[i]!.time - candles15m[i - 1]!.time !== 900) gaps++;
writeFileSync(new URL("./data/BNALL_BTCUSDT.json", import.meta.url), JSON.stringify({ candles15m, oi: [], funding }));
console.log(`BNALL_BTCUSDT: ${candles15m.length} candles over ${((candles15m.at(-1)!.time - candles15m[0]!.time) / 86400).toFixed(0)}d, ${gaps} gaps`);
