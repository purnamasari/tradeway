// 1. Fee Sensitivity Module.
// Trades are simulated cost-free (grossR + riskPct), so each fee level is a
// pure re-pricing — one simulation serves all levels. Fee levels are
// round-trip costs as a fraction of notional (0.0015 = 0.15%, the research
// program's default taker assumption: 0.11% fees + 0.04% slippage).
import { computeMetrics, type Metrics, type ValTrade } from "./metrics.js";

export const DEFAULT_FEE_LEVELS = [0.001, 0.0015, 0.002, 0.0025];

export interface FeeSensitivityRow {
  feeFrac: number;
  metrics: Metrics;
}

export function feeSensitivity(trades: ValTrade[], levels: number[] = DEFAULT_FEE_LEVELS): FeeSensitivityRow[] {
  return levels.map((feeFrac) => ({ feeFrac, metrics: computeMetrics(trades, feeFrac) }));
}
