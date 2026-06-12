// 7. Research Report Generator — orchestrates the whole validation suite for
// a strategy and writes research/output/<name>_validation.md (+ CSV).
//
//   pnpm exec tsx research/validation/validate.ts
//
// Infrastructure only: the canonical strategy parameters are FROZEN. The
// sweep and select-mode walk-forward exist to measure robustness and
// selection inflation, never to re-tune the strategy.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRules } from "../../src/config.js";
import { loadContexts } from "./fast-context.js";
import { runStrategyAll } from "./strategy.js";
import { h18Strategy, H18_CANONICAL } from "./h18.js";
import { computeMetrics, metricsBy, fmtPF, netR, type Metrics, type ValTrade } from "./metrics.js";
import { feeSensitivity, DEFAULT_FEE_LEVELS } from "./fees.js";
import { runSweep, type ParamGrid } from "./sweep.js";
import { walkForwardFixed, walkForwardSelect, type Fold } from "./walkforward.js";
import { runMonteCarlo } from "./montecarlo.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ZECUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT"];
const PREFIX = "BNALL_";
const BASE_FEE = 0.0015; // 0.15% round trip — the research program's taker assumption

const SWEEP_GRID: ParamGrid = {
  donchianDays: [6, 7, 8],
  momentumDays: [25, 30, 35],
  momentumThreshold: [0.03, 0.05, 0.07],
  stopATR: [1.5, 2, 2.5],
  trailATR: [3, 4, 5],
  holdDays: [10, 14, 20],
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
  const factory = (p: Record<string, number>) => h18Strategy(p as never);
  console.error("[validate] building contexts…");
  const ctxs = loadContexts(SYMBOLS, PREFIX, rules);

  // ── Canonical run (parameters frozen) ──────────────────────────────────────
  const canonical = h18Strategy(H18_CANONICAL);
  const trades = runStrategyAll(ctxs, canonical);
  const base = computeMetrics(trades, BASE_FEE);
  console.error(`[validate] canonical: n=${base.n} expectancy=${f3(base.expectancy)} (round-9 reference: n=1206, +0.201)`);

  // ── 1. Fee sensitivity ─────────────────────────────────────────────────────
  const fees = feeSensitivity(trades, DEFAULT_FEE_LEVELS);

  // ── 2. Parameter sweep ─────────────────────────────────────────────────────
  console.error("[validate] sweep…");
  const sweep = runSweep(ctxs, SWEEP_GRID, factory, BASE_FEE, {}, (d, t) => console.error(`[sweep] ${d}/${t}`));

  // ── 3. Walk-forward ────────────────────────────────────────────────────────
  console.error("[validate] walk-forward (fixed)…");
  const wfFixed = walkForwardFixed(ctxs, canonical, FOLDS, BASE_FEE);
  console.error("[validate] walk-forward (select-on-train)…");
  const wfSelect = walkForwardSelect(ctxs, SWEEP_GRID, factory, FOLDS, BASE_FEE);

  // ── 4./5. Symbol + regime analytics ───────────────────────────────────────
  const bySymbol = metricsBy(trades, BASE_FEE, (t) => t.symbol);
  const byRegime = metricsBy(trades, BASE_FEE, (t) => t.regime);

  // ── 6. Monte Carlo ─────────────────────────────────────────────────────────
  const rs = trades.map((t) => netR(t, BASE_FEE));
  const mc = runMonteCarlo(rs, 1000);

  // ── PASS/FAIL criteria (explicit; robustness over top results) ────────────
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
  ];
  const verdict = criteria.every((c) => c.pass) ? "PASS" : "FAIL";

  // ── Outputs ────────────────────────────────────────────────────────────────
  mkdirSync(new URL("../output/", import.meta.url), { recursive: true });

  const csv = ["symbol,trades,expectancy_R,profit_factor,win_rate,max_drawdown_R"];
  for (const [s, m] of bySymbol) {
    csv.push(`${s},${m.n},${f3(m.expectancy)},${Number.isFinite(m.profitFactor) ? f2(m.profitFactor) : "inf"},${(m.winRate).toFixed(3)},${f2(m.maxDrawdownR)}`);
  }
  writeFileSync(new URL("../output/H18_symbols.csv", import.meta.url), csv.join("\n") + "\n");

  const L: string[] = [];
  L.push(`# H18 Validation Report`);
  L.push(``);
  L.push(`Generated ${new Date().toISOString().slice(0, 10)} · dataset ${PREFIX}* (${SYMBOLS.length} symbols, 2023-01..2026-05, 15m bars) · base cost ${(BASE_FEE * 100).toFixed(2)}% round trip`);
  L.push(``);
  L.push(`Strategy (canonical, frozen): 7d Donchian close-break + 30d momentum sign filter (|r| ≥ 5%) + skip-ranging regime; SL 2·ATR1h, chandelier trail 4·ATR1h, 14d cap, 2h entry TTL.`);
  L.push(``);
  L.push(`Canonical baseline: **n=${base.n}, expectancy ${f3(base.expectancy)}R, PF ${fmtPF(base.profitFactor)}, win ${pctS(base.winRate)}, maxDD ${f2(base.maxDrawdownR)}R**`);

  L.push(``, `## 1. Fee sensitivity`, ``);
  L.push(`| Round-trip cost | Trades | Expectancy (R) | Profit factor | Win rate | Max DD (R) |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const r of fees) L.push(`| ${(r.feeFrac * 100).toFixed(2)}% | ${mRow(r.metrics)} |`);

  L.push(``, `## 2. Parameter stability (${sweep.totalVariants} variants)`, ``);
  L.push(`- Robustness score (positive / total): **${f2(sweep.robustnessScore)}** (${sweep.positiveVariants}/${sweep.totalVariants})`);
  L.push(`- Median expectancy: **${f3(sweep.medianExpectancy)}R** · mean: ${f3(sweep.meanExpectancy)}R`);
  L.push(`- Canonical params rank: ${sweep.variants.findIndex((v) => JSON.stringify(v.params) === JSON.stringify(H18_CANONICAL)) + 1} of ${sweep.totalVariants}`);
  L.push(``, `Top 10 by expectancy (for stability inspection — canonical params remain frozen):`, ``);
  L.push(`| dc | mo | thr | stop | trail | hold | n | Exp | PF | Win | DD |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of sweep.variants.slice(0, 10)) {
    const p = v.params;
    L.push(`| ${p.donchianDays} | ${p.momentumDays} | ${p.momentumThreshold} | ${p.stopATR} | ${p.trailATR} | ${p.holdDays} | ${mRow(v.metrics)} |`);
  }
  L.push(``, `Bottom 5:`, ``);
  L.push(`| dc | mo | thr | stop | trail | hold | n | Exp | PF | Win | DD |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of sweep.variants.slice(-5)) {
    const p = v.params;
    L.push(`| ${p.donchianDays} | ${p.momentumDays} | ${p.momentumThreshold} | ${p.stopATR} | ${p.trailATR} | ${p.holdDays} | ${mRow(v.metrics)} |`);
  }

  L.push(``, `## 3. Walk-forward`, ``);
  L.push(`Folds are detection-bounded (a trade belongs to the fold containing its decision bar; outcomes may resolve up to holdDays past the boundary — outcome realization, not signal leakage).`);
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
    L.push(`| ${r.fold.trainStart}..${r.fold.trainEnd} | ${r.fold.testStart}..${r.fold.testEnd} | dc${p.donchianDays}/mo${p.momentumDays}/thr${p.momentumThreshold}/sl${p.stopATR}/tr${p.trailATR}/h${p.holdDays} | ${f3(r.train.expectancy)} | ${f3(r.test.expectancy)} |`);
  }

  L.push(``, `## 4. Per-symbol analytics`, ``);
  L.push(`(Also written to research/output/H18_symbols.csv.)`, ``);
  L.push(`| Symbol | Trades | Expectancy (R) | Profit factor | Win rate | Max DD (R) |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const [s, m] of bySymbol) L.push(`| ${s} | ${mRow(m)} |`);

  L.push(``, `## 5. Regime analytics`, ``);
  L.push(`| Regime | Trades | Expectancy (R) | Profit factor |`);
  L.push(`|---|---|---|---|`);
  for (const reg of REGIMES) {
    const m = byRegime.get(reg);
    L.push(m ? `| ${reg} | ${m.n} | ${f3(m.expectancy)} | ${fmtPF(m.profitFactor)} |` : `| ${reg} | 0 | — | — |`);
  }
  L.push(``, `(H18 skips "ranging" entries by design, so that bucket is structurally empty.)`);

  L.push(``, `## 6. Monte Carlo (${mc.iterations} bootstrap resamples, ${pctS(mc.riskFrac)} equity risk per trade)`, ``);
  L.push(`- Final equity: median **${f2(mc.finalMedian)}×**, 5th pct **${f2(mc.final5)}×**, 95th pct **${f2(mc.final95)}×**`);
  L.push(`- Probability of ruin (equity ≤ ${pctS(mc.ruinThreshold)} of start): **${(100 * mc.probRuin).toFixed(2)}%**`);
  L.push(`- Max drawdown distribution: p5 ${pctS(mc.maxDDPercentiles.p5)}, p25 ${pctS(mc.maxDDPercentiles.p25)}, p50 ${pctS(mc.maxDDPercentiles.p50)}, p75 ${pctS(mc.maxDDPercentiles.p75)}, p95 ${pctS(mc.maxDDPercentiles.p95)}`);
  L.push(``, `Equity envelope (equity multiple at trade #):`, ``);
  L.push(`| Trade # | 5th pct | Median | 95th pct |`);
  L.push(`|---|---|---|---|`);
  for (const pt of mc.curve.filter((_, i) => i % 10 === 9 || i === mc.curve.length - 1)) {
    L.push(`| ${pt.trade} | ${f2(pt.p5)} | ${f2(pt.p50)} | ${f2(pt.p95)} |`);
  }

  L.push(``, `## Verdict: ${verdict}`, ``);
  for (const c of criteria) L.push(`- [${c.pass ? "x" : " "}] ${c.pass ? "PASS" : "FAIL"} — ${c.name} (${c.detail})`);
  L.push(``);
  L.push(verdict === "PASS"
    ? `All robustness criteria hold. The edge is not an artifact of a single fee assumption, parameter cell, period, symbol, regime, or lucky trade ordering.`
    : `One or more robustness criteria failed — see unchecked items above. Do not deploy without addressing them.`);

  writeFileSync(new URL("../output/H18_validation.md", import.meta.url), L.join("\n") + "\n");
  console.error(`[validate] wrote research/output/H18_validation.md — verdict: ${verdict}`);
}

main();
