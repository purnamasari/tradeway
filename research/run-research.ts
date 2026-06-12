// Research backtest runner: replays pre-registered hypotheses over the cached
// 90d of 15m data and prints expectancy broken down by month, regime, and
// symbol. Verdicts follow the acceptance rule in hypotheses.ts and are judged
// on NET avgR under the conservative taker cost model; gross and maker-model
// figures are shown for cost-structure diagnosis only.
//   pnpm exec tsx research/run-research.ts [--round=1|2]
import { writeFileSync } from "node:fs";
import { loadRules } from "../src/config.js";
import { loadSymbolCache, replayResearch, type ResearchTrade } from "./harness.js";
import { HYPOTHESES } from "./hypotheses.js";
import { HYPOTHESES2 } from "./hypotheses2.js";
import { HYPOTHESES3 } from "./hypotheses3.js";
import { HYPOTHESES4 } from "./hypotheses4.js";
import { HYPOTHESES5 } from "./hypotheses5.js";
import { HYPOTHESES6 } from "./hypotheses6.js";
import { HYPOTHESES7 } from "./hypotheses7.js";
import { HYPOTHESES8 } from "./hypotheses8.js";
import { HYPOTHESES9 } from "./hypotheses9.js";

// BTC-only by default (local runs); pass --symbols=... for the full set once
// the server has downloaded the remaining dumps (see research/README.md).
const DEFAULT_SYMBOLS = "BTCUSDT";
const COSTS = { feePct: 0.11, slippagePct: 0.02 }; // taker round trip, as pnpm backtest

// Maker-model sensitivity: limit entry (0.02% maker, no slip), TP exit maker,
// SL/EXPIRED exit taker + slippage. Approximates the execution the bot's
// limit-zone entries imply.
function makerCostR(t: ResearchTrade): number {
  if (!t.filled) return 0;
  const notionalPct = t.status === "TP" ? 0.02 + 0.02 : 0.02 + 0.055 + 0.02;
  return notionalPct / t.riskPct;
}

interface Bucket { n: number; fills: number; wins: number; sumR: number; sumGross: number; sumMaker: number; }
function blank(): Bucket { return { n: 0, fills: 0, wins: 0, sumR: 0, sumGross: 0, sumMaker: 0 }; }
function add(b: Bucket, t: ResearchTrade) {
  b.n++;
  if (t.filled) {
    b.fills++;
    b.sumR += t.rMultiple;
    b.sumGross += t.grossR;
    b.sumMaker += t.grossR - makerCostR(t);
    if (t.rMultiple > 0) b.wins++;
  }
}
function bump(map: Map<string, Bucket>, key: string, t: ResearchTrade) {
  const b = map.get(key) ?? blank();
  add(b, t);
  map.set(key, b);
}
const fmt = (b: Bucket) =>
  `n=${String(b.n).padStart(4)} fills=${String(b.fills).padStart(4)} ` +
  `win%=${b.fills ? ((100 * b.wins) / b.fills).toFixed(0).padStart(3) : "  -"} ` +
  `avgR=${b.fills ? (b.sumR / b.fills).toFixed(3).padStart(7) : "      -"} ` +
  `gross=${b.fills ? (b.sumGross / b.fills).toFixed(3).padStart(7) : "      -"} ` +
  `maker=${b.fills ? (b.sumMaker / b.fills).toFixed(3).padStart(7) : "      -"} ` +
  `totR=${b.sumR.toFixed(1).padStart(7)}`;

function main() {
  const round = Number((process.argv.find((a) => a.startsWith("--round=")) ?? "--round=1").slice(8));
  // --prefix=BN_ selects the Binance dump caches instead of the Bybit DB cache.
  const prefix = (process.argv.find((a) => a.startsWith("--prefix=")) ?? "--prefix=").slice(9);
  const symbols = ((process.argv.find((a) => a.startsWith("--symbols=")) ?? `--symbols=${DEFAULT_SYMBOLS}`).slice(10)).split(",");
  const hypos = round === 9 ? HYPOTHESES9 : round === 8 ? HYPOTHESES8 : round === 7 ? HYPOTHESES7 : round === 6 ? HYPOTHESES6 : round === 5 ? HYPOTHESES5 : round === 4 ? HYPOTHESES4 : round === 3 ? HYPOTHESES3 : round === 2 ? HYPOTHESES2 : HYPOTHESES;
  const rules = loadRules();
  const all: ResearchTrade[] = [];
  for (const sym of symbols) {
    const data = loadSymbolCache(prefix + sym);
    const trades = replayResearch(sym, data, hypos, rules, COSTS);
    console.error(`[research] ${sym}: ${trades.length} trades`);
    all.push(...trades);
  }
  writeFileSync(new URL(`./out/trades-round${round}${prefix ? "-" + prefix.replace(/_$/, "") : ""}.json`, import.meta.url), JSON.stringify(all));

  for (const h of hypos) {
    const trades = all.filter((t) => t.hypothesis === h.name);
    const overall = blank();
    const byMonth = new Map<string, Bucket>();
    const byRegime = new Map<string, Bucket>();
    const bySymbol = new Map<string, Bucket>();
    for (const t of trades) {
      add(overall, t);
      bump(byMonth, t.month, t);
      bump(byRegime, t.regime, t);
      bump(bySymbol, t.symbol, t);
    }

    // Verdict per the pre-registered rule (net taker avgR). Scaled for window
    // length (set before any long-window run): at least 60% of qualifying
    // months (fills >= 5) positive — equivalent to the original 3-of-4 on the
    // 90d window — minimum fills 30 (90d) / 100 (long window), and no regime
    // bucket with fills >= max(15, 5% of total) at avgR < -0.15.
    const months = [...byMonth.entries()].filter(([, b]) => b.fills >= 5);
    const posMonths = months.filter(([, b]) => b.sumR / b.fills > 0).length;
    const needMonths = Math.min(3, months.length) > months.length * 0.6
      ? Math.min(3, months.length)
      : Math.ceil(months.length * 0.6);
    const regimeFloor = Math.max(15, Math.floor(0.05 * Math.max(1, overall.fills)));
    const badRegime = [...byRegime.entries()].some(([, b]) => b.fills >= regimeFloor && b.sumR / b.fills < -0.15);
    const minFills = months.length > 6 ? 100 : 30;
    const avgR = overall.fills ? overall.sumR / overall.fills : 0;
    let verdict: string;
    if (overall.fills < minFills) verdict = `INSUFFICIENT (<${minFills} fills)`;
    else if (avgR > 0 && posMonths >= needMonths && !badRegime) verdict = "ACCEPT";
    else verdict = "REJECT";

    console.log(`\n━━ ${h.name} ── ${verdict}`);
    console.log(`  overall  ${fmt(overall)}`);
    for (const [m, b] of [...byMonth.entries()].sort()) console.log(`  ${m}  ${fmt(b)}`);
    for (const [r, b] of [...byRegime.entries()].sort()) console.log(`  ${r.padEnd(15)} ${fmt(b)}`);
    for (const [s, b] of [...bySymbol.entries()].sort()) console.log(`  ${s.padEnd(9)} ${fmt(b)}`);
  }
}

main();
