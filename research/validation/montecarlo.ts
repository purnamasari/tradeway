// 6. Monte Carlo Simulator.
// Bootstrap-resamples the trade R sequence (with replacement, sequence length
// preserved) and compounds equity at a fixed risk fraction per trade. The
// distribution of resulting equity paths answers: how bad can the SAME
// expectancy look over one unlucky sequence, and how likely is ruin?
// Deterministic RNG (seeded) so reports are reproducible.
export interface MonteCarloResult {
  iterations: number;
  riskFrac: number; // equity fraction risked per trade (1R)
  ruinThreshold: number; // equity fraction defining ruin (e.g. 0.5)
  finalMedian: number; // final equity multiples of start
  final5: number;
  final95: number;
  probRuin: number; // fraction of paths that ever touch the ruin threshold
  maxDDPercentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }; // fractional drawdowns
  /** Pointwise equity envelope at sampled trade indices. */
  curve: Array<{ trade: number; p5: number; p50: number; p95: number }>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))]!;

export function runMonteCarlo(
  tradeRs: number[],
  iterations = 1000,
  opts: { riskFrac?: number; ruinThreshold?: number; seed?: number; curvePoints?: number } = {},
): MonteCarloResult {
  const { riskFrac = 0.01, ruinThreshold = 0.5, seed = 42, curvePoints = 50 } = opts;
  const n = tradeRs.length;
  const rand = mulberry32(seed);

  const finals: number[] = [];
  const maxDDs: number[] = [];
  let ruins = 0;
  const step = Math.max(1, Math.floor(n / curvePoints));
  const sampleIdx: number[] = [];
  for (let i = step - 1; i < n; i += step) sampleIdx.push(i);
  const curveSamples: number[][] = sampleIdx.map(() => []);

  for (let it = 0; it < iterations; it++) {
    let equity = 1;
    let peak = 1;
    let maxDD = 0;
    let ruined = false;
    let s = 0;
    for (let i = 0; i < n; i++) {
      equity *= 1 + riskFrac * tradeRs[Math.floor(rand() * n)]!;
      if (equity > peak) peak = equity;
      const dd = 1 - equity / peak;
      if (dd > maxDD) maxDD = dd;
      if (equity <= ruinThreshold) ruined = true;
      if (s < sampleIdx.length && i === sampleIdx[s]) curveSamples[s++]!.push(equity);
    }
    finals.push(equity);
    maxDDs.push(maxDD);
    if (ruined) ruins++;
  }

  finals.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);
  const curve = sampleIdx.map((trade, s) => {
    const xs = curveSamples[s]!.sort((a, b) => a - b);
    return { trade: trade + 1, p5: pct(xs, 5), p50: pct(xs, 50), p95: pct(xs, 95) };
  });

  return {
    iterations,
    riskFrac,
    ruinThreshold,
    finalMedian: pct(finals, 50),
    final5: pct(finals, 5),
    final95: pct(finals, 95),
    probRuin: ruins / iterations,
    maxDDPercentiles: {
      p5: pct(maxDDs, 5),
      p25: pct(maxDDs, 25),
      p50: pct(maxDDs, 50),
      p75: pct(maxDDs, 75),
      p95: pct(maxDDs, 95),
    },
    curve,
  };
}
