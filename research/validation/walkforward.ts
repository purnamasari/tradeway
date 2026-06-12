// 3. Walk Forward Engine.
// Folds are detection-bounded: a trade belongs to the fold whose range
// contains its DECISION bar; outcomes may resolve up to holdDays past the
// boundary (outcome realization, not signal leakage — the decision used no
// future data). Two modes:
//   fixed  — the same frozen parameters evaluated on train and test, fold by
//            fold (tests stationarity of the canonical strategy).
//   select — parameters are chosen on the train range only (best expectancy
//            in the sweep grid), then FROZEN and evaluated on test. Measures
//            how much in-sample selection inflates results.
import type { FastContext } from "./fast-context.js";
import type { Strategy } from "./strategy.js";
import { runStrategyAll } from "./strategy.js";
import { computeMetrics, type Metrics } from "./metrics.js";
import { runSweep, type ParamGrid } from "./sweep.js";

export interface Fold {
  trainStart: string; // "YYYY-MM" inclusive
  trainEnd: string; // "YYYY-MM" inclusive
  testStart: string;
  testEnd: string;
}

export interface FoldResult {
  fold: Fold;
  train: Metrics;
  test: Metrics;
  /** Params used on the test range (canonical in fixed mode; train-selected in select mode). */
  params: Record<string, number>;
}

const monthStartSec = (ym: string): number => Date.parse(`${ym}-01T00:00:00Z`) / 1000;
function monthEndSec(ym: string): number {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return Date.parse(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, "0")}-01T00:00:00Z`) / 1000;
}

export function walkForwardFixed(ctxs: FastContext[], strat: Strategy, folds: Fold[], feeFrac: number): FoldResult[] {
  return folds.map((fold) => {
    const train = runStrategyAll(ctxs, strat, { fromSec: monthStartSec(fold.trainStart), toSec: monthEndSec(fold.trainEnd) });
    const test = runStrategyAll(ctxs, strat, { fromSec: monthStartSec(fold.testStart), toSec: monthEndSec(fold.testEnd) });
    return { fold, train: computeMetrics(train, feeFrac), test: computeMetrics(test, feeFrac), params: strat.params };
  });
}

export function walkForwardSelect(
  ctxs: FastContext[],
  grid: ParamGrid,
  factory: (params: Record<string, number>) => Strategy,
  folds: Fold[],
  feeFrac: number,
): FoldResult[] {
  return folds.map((fold) => {
    const trainBounds = { fromSec: monthStartSec(fold.trainStart), toSec: monthEndSec(fold.trainEnd) };
    const sweep = runSweep(ctxs, grid, factory, feeFrac, trainBounds);
    const best = sweep.variants[0]!; // chosen on train only, frozen for test
    const strat = factory(best.params);
    const test = runStrategyAll(ctxs, strat, { fromSec: monthStartSec(fold.testStart), toSec: monthEndSec(fold.testEnd) });
    return { fold, train: best.metrics, test: computeMetrics(test, feeFrac), params: best.params };
  });
}
