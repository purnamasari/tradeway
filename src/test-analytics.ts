// Offline check for the analytics formatters — no DB. Builds a synthetic report
// and renders both the full CLI text and the compact Telegram digest.
//   pnpm test:analytics
import { formatReportText, formatDigest, type AnalyticsReport } from "./analytics/report.js";

const report: AnalyticsReport = {
  windowDays: 30,
  generatedAt: new Date().toISOString(),
  summary: { tp: 18, sl: 11, expired: 4, open: 2, total: 35, resolved: 29, winRatePct: 62.1 },
  byStrategy: [
    { key: "liquidity_sweep", wins: 9, losses: 3, resolved: 12, winRatePct: 75.0, avgDurationMs: 2 * 3600_000 },
    { key: "trend_pullback", wins: 6, losses: 4, resolved: 10, winRatePct: 60.0, avgDurationMs: 3.5 * 3600_000 },
    { key: "squeeze", wins: 3, losses: 4, resolved: 7, winRatePct: 42.9, avgDurationMs: 1.2 * 3600_000 },
  ],
  byDirection: [
    { key: "long", wins: 11, losses: 5, resolved: 16, winRatePct: 68.8, avgDurationMs: 2.5 * 3600_000 },
    { key: "short", wins: 7, losses: 6, resolved: 13, winRatePct: 53.8, avgDurationMs: 2.1 * 3600_000 },
  ],
  bySymbol: [
    { key: "BTCUSDT", wins: 6, losses: 2, resolved: 8, winRatePct: 75.0, avgDurationMs: 2.4 * 3600_000 },
    { key: "ETHUSDT", wins: 5, losses: 4, resolved: 9, winRatePct: 55.6, avgDurationMs: 2.2 * 3600_000 },
  ],
  byRegime: [
    { key: "ranging", wins: 10, losses: 4, resolved: 14, winRatePct: 71.4, avgDurationMs: 2.3 * 3600_000 },
    { key: "trending", wins: 8, losses: 7, resolved: 15, winRatePct: 53.3, avgDurationMs: 2.6 * 3600_000 },
  ],
  byConfidenceBucket: [
    { key: "70-79", wins: 4, losses: 5, resolved: 9, winRatePct: 44.4, avgDurationMs: 2 * 3600_000 },
    { key: "80-89", wins: 7, losses: 4, resolved: 11, winRatePct: 63.6, avgDurationMs: 2.3 * 3600_000 },
    { key: "90-100", wins: 7, losses: 2, resolved: 9, winRatePct: 77.8, avgDurationMs: 2.5 * 3600_000 },
  ],
  byEdgeState: [
    { key: "ACTIVE", wins: 14, losses: 5, resolved: 19, winRatePct: 73.7, avgDurationMs: 2.4 * 3600_000 },
    { key: "EDGE_WEAKENING", wins: 3, losses: 3, resolved: 6, winRatePct: 50.0, avgDurationMs: 2.1 * 3600_000 },
    { key: "INVALIDATED", wins: 1, losses: 3, resolved: 4, winRatePct: 25.0, avgDurationMs: 1.5 * 3600_000 },
  ],
  confidenceDecay: { winnersDecay: 6.2, losersDecay: 21.7 },
  factorEffectiveness: { winFunding: 91.3, lossFunding: 64.8, winOiZscore: -2.8, lossOiZscore: -1.1 },
  durations: { tpMs: 2.6 * 3600_000, slMs: 1.9 * 3600_000 },
  manualTrades: { open: 1, closed: 3, wins: 2, losses: 1, avgPnlPct: 3.41 },
  pnl: { trades: 33, totalR: 11.4, avgR: 0.35, avgWinPct: 2.31, avgLossPct: -1.18 },
};

console.log(formatReportText(report));
console.log("\n\n========== DIGEST ==========\n");
console.log(formatDigest(report));
