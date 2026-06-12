// Design-phase probe: a handful of THEORY-MOTIVATED SMC variants on the
// design symbols only (BTC + SOL — the other six stay untouched as
// out-of-sample for the validation suite).
//
// AUDIT-TRAIL NOTE: this file shows the FINAL round (5) of the design
// sequence. Variants are expressed relative to SMC_CANONICAL, which was
// frozen to round 5's winner (O+T) afterwards — re-running today therefore
// reproduces the round-5 numbers only for the cells that don't overlap the
// baked-in winners. Rounds 1-4 (geometry scale, breakeven on/off, market vs
// FVG entry, deep-entry fraction, frequency funnel) are summarized in the
// validation report and research/README.md. Levers probed:
//   geometry scale (pivotK/lookback — research finding: 15m-scale risk
//   distances lose ~0.2-0.3R to taker costs; 1h-scale loses ~0.05-0.1R),
//   breakeven on/off (BE stops can scratch eventual winners),
//   minimum reward:risk.
import { loadRules } from "../../src/config.js";
import { SMC_CANONICAL, type SmcParams } from "../../src/strategies/smc-core.js";
import { loadContexts } from "./fast-context.js";
import { runStrategyAll } from "./strategy.js";
import { smcStrategy } from "./smc.js";
import { computeMetrics } from "./metrics.js";

const DESIGN_SYMBOLS = ["BTCUSDT", "SOLUSDT"];
const FEE = 0.0015;

const B: SmcParams = { ...SMC_CANONICAL, beTriggerR: 0 };
const K: SmcParams = { ...B, fvgMinAtr: 0.5 };
const H_MS = 3_600_000;
const O: SmcParams = { ...B, fvgMinAtr: 0.75 };
const variants: Array<{ name: string; p: SmcParams }> = [
  { name: "O   = FVG ≥ 0.75 (ref)", p: O },
  { name: "O+U = lookback 384", p: { ...O, liqLookbackBars: 384 } },
  { name: "O+X = minRR 1.2", p: { ...O, minRR: 1.2 } },
  { name: "O+T = sweep 12", p: { ...O, sweepWindow: 12 } },
  { name: "O+U+X", p: { ...O, liqLookbackBars: 384, minRR: 1.2 } },
  { name: "O+T+U+X", p: { ...O, sweepWindow: 12, liqLookbackBars: 384, minRR: 1.2 } },
  { name: "O+T+U+X+W (=Z+X)", p: { ...O, sweepWindow: 12, liqLookbackBars: 384, minRR: 1.2, entryTtlMs: 4 * H_MS } },
];

const rules = loadRules();
const ctxs = loadContexts(DESIGN_SYMBOLS, "BNALL_", rules);
for (const v of variants) {
  const trades = runStrategyAll(ctxs, smcStrategy(v.p));
  const m = computeMetrics(trades, FEE);
  const gross = computeMetrics(trades, 0);
  const tpN = trades.filter((t) => t.status === "TP").length;
  const slN = trades.filter((t) => t.status === "SL").length;
  const beN = trades.filter((t) => t.status === "BE").length;
  console.log(
    `${v.name}: n=${m.n} exp=${m.expectancy.toFixed(3)} (gross ${gross.expectancy.toFixed(3)}) ` +
      `PF=${m.profitFactor.toFixed(2)} win=${(100 * m.winRate).toFixed(0)}% TP/SL/BE=${tpN}/${slN}/${beN}`,
  );
}
