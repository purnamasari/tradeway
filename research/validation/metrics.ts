// Trade metrics for the validation framework. All performance numbers are in
// R units. Trades are stored cost-FREE (grossR + riskPct); net R under any
// fee assumption is derived, so one simulation run serves every fee level.
export interface ValTrade {
  symbol: string;
  direction: "long" | "short";
  detectedAt: number; // unix ms, decision-bar close
  month: string; // YYYY-MM
  regime: string; // regime label at detection
  status: string; // SL | TRAIL | EXPIRED
  grossR: number; // R before costs
  riskPct: number; // |entry − SL| as % of entry — converts fees to R
  durationMs: number | null;
}

/** Net R for a trade under a round-trip cost expressed as a FRACTION of
 *  notional (e.g. 0.0015 = 0.15%). costR = costFrac / (riskPct/100). */
export function netR(t: ValTrade, costFrac: number): number {
  return t.grossR - (costFrac * 100) / t.riskPct;
}

export interface Metrics {
  n: number;
  expectancy: number; // mean net R per trade
  winRate: number; // fraction of trades with net R > 0
  profitFactor: number; // sum(wins) / |sum(losses)|; Infinity if no losses
  totR: number;
  maxDrawdownR: number; // peak-to-trough on the cumulative-R curve, trade order
}

export function computeMetrics(trades: ValTrade[], costFrac: number): Metrics {
  const ordered = [...trades].sort((a, b) => a.detectedAt - b.detectedAt);
  let wins = 0;
  let sumPos = 0;
  let sumNeg = 0;
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of ordered) {
    const r = netR(t, costFrac);
    if (r > 0) {
      wins++;
      sumPos += r;
    } else sumNeg += r;
    cum += r;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const n = ordered.length;
  return {
    n,
    expectancy: n ? (sumPos + sumNeg) / n : 0,
    winRate: n ? wins / n : 0,
    profitFactor: sumNeg < 0 ? sumPos / -sumNeg : sumPos > 0 ? Infinity : 0,
    totR: sumPos + sumNeg,
    maxDrawdownR: maxDD,
  };
}

export const fmtPF = (pf: number): string => (Number.isFinite(pf) ? pf.toFixed(2) : "inf");

/** Group helper: metrics per key (symbol, regime, month, …). */
export function metricsBy(
  trades: ValTrade[],
  costFrac: number,
  key: (t: ValTrade) => string,
): Map<string, Metrics> {
  const groups = new Map<string, ValTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  return new Map([...groups.entries()].sort().map(([k, g]) => [k, computeMetrics(g, costFrac)]));
}
