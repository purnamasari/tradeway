// SMC validation suite — same orchestration as validate.ts (H18), pointed at
// the SMC strategy. Writes research/output/SMC_validation.md (+ CSV).
//
//   pnpm exec tsx research/validation/validate-smc.ts
//
// Infrastructure only: SMC_CANONICAL (src/strategies/smc-core.ts) is FROZEN —
// it was designed on BTC+SOL only (probe-smc.ts); the other six symbols are
// out-of-sample here. The sweep and select-mode walk-forward measure
// robustness and selection inflation, never re-tune.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRules } from "../../src/config.js";
import { SMC_CANONICAL } from "../../src/strategies/smc-core.js";
import { loadContexts } from "./fast-context.js";
import { runStrategyAll } from "./strategy.js";
import { smcStrategy } from "./smc.js";
import { computeMetrics, metricsBy, fmtPF, netR, type Metrics } from "./metrics.js";
import { feeSensitivity, DEFAULT_FEE_LEVELS } from "./fees.js";
import { runSweep, type ParamGrid } from "./sweep.js";
import { walkForwardFixed, walkForwardSelect, type Fold } from "./walkforward.js";
import { runMonteCarlo } from "./montecarlo.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ZECUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT"];
const DESIGN_SYMBOLS = new Set(["BTCUSDT", "SOLUSDT"]);
const PREFIX = "BNALL_";
const BASE_FEE = 0.0015; // 0.15% round trip — the research program's taker assumption

const SWEEP_GRID: ParamGrid = {
  pivotK: [2, 3, 4],
  sweepWindow: [8, 12, 16],
  fvgMinAtr: [0.5, 0.75, 1],
  minRR: [1.2, 1.5, 2],
};

const FOLDS: Fold[] = [
  { trainStart: "2023-01", trainEnd: "2023-12", testStart: "2024-01", testEnd: "2024-12" },
  { trainStart: "2023-01", trainEnd: "2024-12", testStart: "2025-01", testEnd: "2025-12" },
  { trainStart: "2024-01", trainEnd: "2025-12", testStart: "2026-01", testEnd: "2026-05" },
];

const REGIMES = ["trending", "ranging", "high_volatility", "low_volatility"];

const f3 = (x: number) => x.toFixed(3);
const f2 = (x: number) => x.toFixed(2);
const pctS = (x: number) => `${(100 * x).toFixed(0)}%`;
const mRow = (m: Metrics) =>
  `${m.n} | ${f3(m.expectancy)} | ${fmtPF(m.profitFactor)} | ${pctS(m.winRate)} | ${f2(m.maxDrawdownR)}`;

function main() {
  const rules = loadRules();
  const factory = (p: Record<string, number>) => smcStrategy({ ...SMC_CANONICAL, ...p });
  console.error("[validate-smc] building contexts…");
  const ctxs = loadContexts(SYMBOLS, PREFIX, rules);

  // ── Canonical run (parameters frozen) ──────────────────────────────────────
  const canonical = smcStrategy(SMC_CANONICAL);
  const trades = runStrategyAll(ctxs, canonical);
  const base = computeMetrics(trades, BASE_FEE);
  console.error(`[validate-smc] canonical: n=${base.n} expectancy=${f3(base.expectancy)}`);

  // ── 1. Fee sensitivity ─────────────────────────────────────────────────────
  const fees = feeSensitivity(trades, DEFAULT_FEE_LEVELS);

  // ── 2. Parameter sweep ─────────────────────────────────────────────────────
  console.error("[validate-smc] sweep…");
  const sweep = runSweep(ctxs, SWEEP_GRID, factory, BASE_FEE, {}, (d, t) => console.error(`[sweep] ${d}/${t}`));

  // ── 3. Walk-forward ────────────────────────────────────────────────────────
  console.error("[validate-smc] walk-forward (fixed)…");
  const wfFixed = walkForwardFixed(ctxs, canonical, FOLDS, BASE_FEE);
  console.error("[validate-smc] walk-forward (select-on-train)…");
  const wfSelect = walkForwardSelect(ctxs, SWEEP_GRID, factory, FOLDS, BASE_FEE);

  // ── 4./5. Symbol + regime + status analytics ──────────────────────────────
  const bySymbol = metricsBy(trades, BASE_FEE, (t) => t.symbol);
  const byRegime = metricsBy(trades, BASE_FEE, (t) => t.regime);
  const byStatus = metricsBy(trades, BASE_FEE, (t) => t.status);
  const byDirection = metricsBy(trades, BASE_FEE, (t) => t.direction);
  const oosTrades = trades.filter((t) => !DESIGN_SYMBOLS.has(t.symbol));
  const oos = computeMetrics(oosTrades, BASE_FEE);
  const design = computeMetrics(trades.filter((t) => DESIGN_SYMBOLS.has(t.symbol)), BASE_FEE);

  // ── 6. Monte Carlo ─────────────────────────────────────────────────────────
  const rs = trades.map((t) => netR(t, BASE_FEE));
  const mc = runMonteCarlo(rs, 1000);

  // ── PASS/FAIL criteria (identical bar to H18's report) ─────────────────────
  const wfPositive = wfFixed.filter((f) => f.test.expectancy > 0).length;
  const symPositive = [...bySymbol.values()].filter((m) => m.expectancy > 0).length;
  const regimeBucketsOk = [...byRegime.entries()].every(([, m]) => m.n < 30 || m.expectancy > 0);
  const criteria: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: "Fee robustness: expectancy > 0 at every level ≤ 0.20%",
      pass: fees.filter((r) => r.feeFrac <= 0.002).every((r) => r.metrics.expectancy > 0),
      detail: fees.map((r) => `${(r.feeFrac * 100).toFixed(2)}%→${f3(r.metrics.expectancy)}`).join(", "),
    },
    {
      name: "Parameter stability: robustness ≥ 0.70 and median expectancy > 0",
      pass: sweep.robustnessScore >= 0.7 && sweep.medianExpectancy > 0,
      detail: `robustness ${f2(sweep.robustnessScore)} (${sweep.positiveVariants}/${sweep.totalVariants}), median ${f3(sweep.medianExpectancy)}`,
    },
    {
      name: "Walk-forward (frozen params): test expectancy > 0 in ≥ 2 of 3 folds",
      pass: wfPositive >= 2,
      detail: `${wfPositive}/${FOLDS.length} folds positive`,
    },
    {
      name: "Symbols: ≥ 75% with positive expectancy",
      pass: symPositive / bySymbol.size >= 0.75,
      detail: `${symPositive}/${bySymbol.size} positive`,
    },
    {
      name: "Regimes: every traded bucket with n ≥ 30 positive",
      pass: regimeBucketsOk,
      detail: [...byRegime.entries()].map(([r, m]) => `${r}:${f3(m.expectancy)}(n=${m.n})`).join(", "),
    },
    {
      name: "Monte Carlo: P(ruin) < 1% and 5th-pct final ≥ 0.85× start (1% risk)",
      pass: mc.probRuin < 0.01 && mc.final5 >= 0.85,
      detail: `P(ruin)=${(100 * mc.probRuin).toFixed(2)}%, 5th-pct final=${f2(mc.final5)}×`,
    },
    {
      name: "Symbol-OOS: expectancy > 0 on the 6 symbols never used in design",
      pass: oos.expectancy > 0,
      detail: `design(BTC,SOL) ${f3(design.expectancy)} (n=${design.n}) · OOS ${f3(oos.expectancy)} (n=${oos.n})`,
    },
  ];
  const verdict = criteria.every((c) => c.pass) ? "PASS" : "FAIL";

  // ── Outputs ────────────────────────────────────────────────────────────────
  mkdirSync(new URL("../output/", import.meta.url), { recursive: true });

  const csv = ["symbol,trades,expectancy_R,profit_factor,win_rate,max_drawdown_R"];
  for (const [s, m] of bySymbol) {
    csv.push(`${s},${m.n},${f3(m.expectancy)},${Number.isFinite(m.profitFactor) ? f2(m.profitFactor) : "inf"},${m.winRate.toFixed(3)},${f2(m.maxDrawdownR)}`);
  }
  writeFileSync(new URL("../output/SMC_symbols.csv", import.meta.url), csv.join("\n") + "\n");

  const months = new Set(trades.map((t) => t.month)).size;
  const L: string[] = [];
  L.push(`# SMC Validation Report`);
  L.push(``);
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} · dataset ${PREFIX}* (${SYMBOLS.length} symbols, 2023-01..2026-05, 15m bars) · base cost ${(BASE_FEE * 100).toFixed(2)}% round trip`);
  L.push(``);
  L.push(`Strategy (canonical, frozen — src/strategies/smc-core.ts): liquidity-sweep of an intact swing pool (within 3h) + first-close break of structure + displacement FVG ≥ 0.75·ATR15 as the limit-entry zone, taken only in ranging/high_volatility regimes; SL beyond min(sweep wick, order block) − 0.25·ATR15; TP at the nearest untapped opposing liquidity pool (skip if < 1.5R, cap 3R, default 2R); 2h entry TTL, 48h max hold, no breakeven/trail.`);
  L.push(``);
  L.push(`Design protocol: rule family + parameters chosen on BTC+SOL only (probe-smc.ts, 5 rounds); ETH, ZEC, XRP, DOGE, LINK, AVAX untouched until the round-6 pooled run. DISCLOSED POST-HOC STEP: the regime gate (trade only ranging/high_volatility — the complement of H18's skip-ranging) was added AFTER round-6 regime analytics showed trending −0.06 / low_vol −0.04 vs ranging +0.35 / high_vol +0.32; it is theory-consistent (sweep-reversals are range phenomena) but was not pre-registered, so treat the walk-forward as the binding check on it.`);
  L.push(``);
  L.push(`Canonical baseline: **n=${base.n}, expectancy ${f3(base.expectancy)}R, PF ${fmtPF(base.profitFactor)}, win ${pctS(base.winRate)}, maxDD ${f2(base.maxDrawdownR)}R** · ≈${(base.n / months).toFixed(1)} trades/month portfolio-wide`);

  L.push(``, `## 1. Fee sensitivity`, ``);
  L.push(`| Round-trip cost | Trades | Expectancy (R) | Profit factor | Win rate | Max DD (R) |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const r of fees) L.push(`| ${(r.feeFrac * 100).toFixed(2)}% | ${mRow(r.metrics)} |`);
  L.push(``, `Entries are resting limit orders at the FVG, so a maker-entry fill model (≈0.10% round trip) is structurally defensible; the 0.15% row is the program's standard taker assumption and is the verdict basis.`);

  L.push(``, `## 2. Parameter stability (${sweep.totalVariants} variants)`, ``);
  L.push(`- Robustness score (positive / total): **${f2(sweep.robustnessScore)}** (${sweep.positiveVariants}/${sweep.totalVariants})`);
  L.push(`- Median expectancy: **${f3(sweep.medianExpectancy)}R** · mean: ${f3(sweep.meanExpectancy)}R`);
  L.push(``, `Top 10 by expectancy (for stability inspection — canonical params remain frozen):`, ``);
  L.push(`| pivotK | sweepW | fvgMin | minRR | n | Exp | PF | Win | DD |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const v of sweep.variants.slice(0, 10)) {
    const p = v.params;
    L.push(`| ${p.pivotK} | ${p.sweepWindow} | ${p.fvgMinAtr} | ${p.minRR} | ${mRow(v.metrics)} |`);
  }
  L.push(``, `Bottom 5:`, ``);
  L.push(`| pivotK | sweepW | fvgMin | minRR | n | Exp | PF | Win | DD |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const v of sweep.variants.slice(-5)) {
    const p = v.params;
    L.push(`| ${p.pivotK} | ${p.sweepWindow} | ${p.fvgMinAtr} | ${p.minRR} | ${mRow(v.metrics)} |`);
  }

  L.push(``, `## 3. Walk-forward`, ``);
  L.push(`Folds are detection-bounded (a trade belongs to the fold containing its decision bar).`);
  L.push(``, `**Fixed mode** — canonical parameters frozen throughout:`, ``);
  L.push(`| Train | Test | Train n / Exp / PF | Test n / Exp / PF |`);
  L.push(`|---|---|---|---|`);
  for (const r of wfFixed) {
    L.push(`| ${r.fold.trainStart}..${r.fold.trainEnd} | ${r.fold.testStart}..${r.fold.testEnd} | ${r.train.n} / ${f3(r.train.expectancy)} / ${fmtPF(r.train.profitFactor)} | ${r.test.n} / ${f3(r.test.expectancy)} / ${fmtPF(r.test.profitFactor)} |`);
  }
  L.push(``, `**Select mode** — best-by-expectancy params chosen on train only, frozen for test (measures selection inflation):`, ``);
  L.push(`| Train | Test | Selected params | Train Exp | Test Exp |`);
  L.push(`|---|---|---|---|---|`);
  for (const r of wfSelect) {
    const p = r.params;
    L.push(`| ${r.fold.trainStart}..${r.fold.trainEnd} | ${r.fold.testStart}..${r.fold.testEnd} | k${p.pivotK}/sw${p.sweepWindow}/fvg${p.fvgMinAtr}/rr${p.minRR} | ${f3(r.train.expectancy)} | ${f3(r.test.expectancy)} |`);
  }

  L.push(``, `## 4. Per-symbol analytics`, ``);
  L.push(`(Also written to research/output/SMC_symbols.csv. BTC and SOL are the design symbols; the rest are symbol-OOS.)`, ``);
  L.push(`| Symbol | Trades | Expectancy (R) | Profit factor | Win rate | Max DD (R) |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const [s, m] of bySymbol) L.push(`| ${s}${DESIGN_SYMBOLS.has(s) ? " (design)" : ""} | ${mRow(m)} |`);
  L.push(``, `Design vs OOS: design ${f3(design.expectancy)}R (n=${design.n}) · **symbol-OOS ${f3(oos.expectancy)}R (n=${oos.n})**`);

  L.push(``, `## 5. Regime / direction / exit analytics`, ``);
  L.push(`| Regime | Trades | Expectancy (R) | Profit factor |`);
  L.push(`|---|---|---|---|`);
  for (const reg of REGIMES) {
    const m = byRegime.get(reg);
    L.push(m ? `| ${reg} | ${m.n} | ${f3(m.expectancy)} | ${fmtPF(m.profitFactor)} |` : `| ${reg} | 0 | — | — |`);
  }
  L.push(``, `| Direction | Trades | Expectancy (R) |`, `|---|---|---|`);
  for (const [d, m] of byDirection) L.push(`| ${d} | ${m.n} | ${f3(m.expectancy)} |`);
  L.push(``, `| Exit | Trades | Expectancy (R) |`, `|---|---|---|`);
  for (const [s, m] of byStatus) L.push(`| ${s} | ${m.n} | ${f3(m.expectancy)} |`);

  L.push(``, `## 6. Monte Carlo (${mc.iterations} bootstrap resamples, ${pctS(mc.riskFrac)} equity risk per trade)`, ``);
  L.push(`- Final equity: median **${f2(mc.finalMedian)}×**, 5th pct **${f2(mc.final5)}×**, 95th pct **${f2(mc.final95)}×**`);
  L.push(`- Probability of ruin (equity ≤ ${pctS(mc.ruinThreshold)} of start): **${(100 * mc.probRuin).toFixed(2)}%**`);
  L.push(`- Max drawdown distribution: p5 ${pctS(mc.maxDDPercentiles.p5)}, p25 ${pctS(mc.maxDDPercentiles.p25)}, p50 ${pctS(mc.maxDDPercentiles.p50)}, p75 ${pctS(mc.maxDDPercentiles.p75)}, p95 ${pctS(mc.maxDDPercentiles.p95)}`);

  L.push(``, `## Verdict: ${verdict}`, ``);
  for (const c of criteria) L.push(`- [${c.pass ? "x" : " "}] ${c.pass ? "PASS" : "FAIL"} — ${c.name} (${c.detail})`);
  L.push(``);
  L.push(verdict === "PASS"
    ? `All robustness criteria hold. The edge is not an artifact of a single fee assumption, parameter cell, period, symbol, regime, or lucky trade ordering.`
    : `One or more robustness criteria failed — see unchecked items above. Do not deploy without addressing them.`);

  writeFileSync(new URL("../output/SMC_validation.md", import.meta.url), L.join("\n") + "\n");
  console.error(`[validate-smc] wrote research/output/SMC_validation.md — verdict: ${verdict}`);
}

main();
