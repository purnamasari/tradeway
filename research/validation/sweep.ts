// 2. Parameter Sweep Framework.
// Runs every combination of a parameter grid through the strategy factory and
// summarizes the DISTRIBUTION of outcomes. The point is robustness — a real
// edge should survive neighboring parameter values — NOT to pick a better
// combination. Canonical parameters stay frozen regardless of ranking.
import type { FastContext } from "./fast-context.js";
import { runStrategyAll, type RunBounds, type Strategy } from "./strategy.js";
import { computeMetrics, type Metrics } from "./metrics.js";

export type ParamGrid = Record<string, number[]>;

export interface SweepVariant {
  params: Record<string, number>;
  metrics: Metrics;
}

export interface SweepResult {
  variants: SweepVariant[]; // sorted by expectancy, descending
  medianExpectancy: number;
  meanExpectancy: number;
  /** positive_variants / total_variants (net expectancy > 0). */
  robustnessScore: number;
  positiveVariants: number;
  totalVariants: number;
}

export function* cartesian(grid: ParamGrid): Generator<Record<string, number>> {
  const keys = Object.keys(grid);
  const idx = new Array<number>(keys.length).fill(0);
  while (true) {
    yield Object.fromEntries(keys.map((k, j) => [k, grid[k]![idx[j]!]!]));
    let j = keys.length - 1;
    while (j >= 0) {
      idx[j]!++;
      if (idx[j]! < grid[keys[j]!]!.length) break;
      idx[j] = 0;
      j--;
    }
    if (j < 0) return;
  }
}

export function runSweep(
  ctxs: FastContext[],
  grid: ParamGrid,
  factory: (params: Record<string, number>) => Strategy,
  feeFrac: number,
  bounds: RunBounds = {},
  onProgress?: (done: number, total: number) => void,
): SweepResult {
  const total = Object.values(grid).reduce((a, v) => a * v.length, 1);
  const variants: SweepVariant[] = [];
  let done = 0;
  for (const params of cartesian(grid)) {
    const trades = runStrategyAll(ctxs, factory(params), bounds);
    variants.push({ params, metrics: computeMetrics(trades, feeFrac) });
    done++;
    if (onProgress && done % 25 === 0) onProgress(done, total);
  }
  variants.sort((a, b) => b.metrics.expectancy - a.metrics.expectancy);
  const exps = variants.map((v) => v.metrics.expectancy).sort((a, b) => a - b);
  const mid = exps.length >> 1;
  const positive = variants.filter((v) => v.metrics.expectancy > 0).length;
  return {
    variants,
    medianExpectancy: exps.length % 2 ? exps[mid]! : (exps[mid - 1]! + exps[mid]!) / 2,
    meanExpectancy: exps.reduce((a, b) => a + b, 0) / exps.length,
    robustnessScore: positive / variants.length,
    positiveVariants: positive,
    totalVariants: variants.length,
  };
}
