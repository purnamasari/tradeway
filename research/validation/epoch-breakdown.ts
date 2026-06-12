// Temporal-regime evidence for the goal's success metric ("positive
// expectancy across multiple market regimes"): the CANONICAL frozen H18
// evaluated per calendar year and per volatility/trend regime — pure
// reporting on the already-validated strategy, no parameter changes.
//   pnpm exec tsx research/validation/epoch-breakdown.ts
import { loadRules } from "../../src/config.js";
import { loadContexts } from "./fast-context.js";
import { runStrategyAll } from "./strategy.js";
import { h18Strategy } from "./h18.js";
import { computeMetrics, metricsBy, fmtPF, type Metrics } from "./metrics.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ZECUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT"];
const FEE = 0.0015;

const row = (label: string, m: Metrics) =>
  `${label.padEnd(22)} n=${String(m.n).padStart(4)} exp=${m.expectancy.toFixed(3).padStart(7)} ` +
  `PF=${fmtPF(m.profitFactor).padStart(5)} win=${(100 * m.winRate).toFixed(0).padStart(3)}% maxDD=${m.maxDrawdownR.toFixed(1)}R`;

function main() {
  const rules = loadRules();
  const ctxs = loadContexts(SYMBOLS, "BNALL_", rules);
  const trades = runStrategyAll(ctxs, h18Strategy());
  console.log(row("OVERALL", computeMetrics(trades, FEE)));

  console.log("\nBy calendar year (epoch):");
  for (const [y, m] of metricsBy(trades, FEE, (t) => t.month.slice(0, 4))) console.log(row(y, m));

  console.log("\nBy regime at detection:");
  for (const [r, m] of metricsBy(trades, FEE, (t) => t.regime)) console.log(row(r, m));

  console.log("\nBy year × regime:");
  for (const [k, m] of metricsBy(trades, FEE, (t) => `${t.month.slice(0, 4)}/${t.regime}`)) console.log(row(k, m));
}

main();
