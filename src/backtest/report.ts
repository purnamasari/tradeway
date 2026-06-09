// Aggregates backtest trades into performance metrics and renders a text report.
import type { BacktestTrade } from "./engine.js";

export interface GroupStats {
  key: string;
  signals: number; // times the strategy fired & passed gates
  fills: number; // of those, entered
  tp: number;
  sl: number;
  expired: number;
  winRatePct: number | null; // tp / (tp+sl)
  expectancyR: number | null; // mean realized R over filled trades
  profitFactor: number | null; // gross win R / gross loss R
  avgDurationMs: number | null;
  fillRatePct: number;
}

function stats(key: string, trades: BacktestTrade[]): GroupStats {
  const signals = trades.length;
  const filled = trades.filter((t) => t.filled);
  const tp = filled.filter((t) => t.status === "TP").length;
  const sl = filled.filter((t) => t.status === "SL").length;
  const expired = filled.filter((t) => t.status === "EXPIRED").length;
  const resolved = tp + sl;

  const rs = filled.map((t) => t.rMultiple);
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const durs = filled.map((t) => t.durationMs).filter((d): d is number => d != null);

  return {
    key,
    signals,
    fills: filled.length,
    tp,
    sl,
    expired,
    winRatePct: resolved === 0 ? null : Math.round((tp / resolved) * 1000) / 10,
    expectancyR: filled.length === 0 ? null : round2(rs.reduce((a, b) => a + b, 0) / filled.length),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : null) : round2(grossWin / grossLoss),
    avgDurationMs: durs.length === 0 ? null : durs.reduce((a, b) => a + b, 0) / durs.length,
    fillRatePct: signals === 0 ? 0 : Math.round((filled.length / signals) * 1000) / 10,
  };
}

/** Max peak-to-trough drawdown of the cumulative-R equity curve (filled trades, by time). */
function maxDrawdownR(trades: BacktestTrade[]): number {
  const filled = trades.filter((t) => t.filled).sort((a, b) => a.detectedAt - b.detectedAt);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of filled) {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return round2(maxDd);
}

const STRATEGIES = ["momentum", "liquidity_sweep", "trend_pullback", "squeeze"];
const BUCKETS = ["<60", "60-69", "70-79", "80-89", "90-100"];

function bucketOf(conf: number): string {
  if (conf >= 90) return "90-100";
  if (conf >= 80) return "80-89";
  if (conf >= 70) return "70-79";
  if (conf >= 60) return "60-69";
  return "<60";
}

export interface ReportMeta {
  windowDays: number;
  stepMin: number;
  symbols: string[];
  feePct: number;
  slippagePct: number;
}

export function formatBacktestReport(trades: BacktestTrade[], meta: ReportMeta): string {
  const out: string[] = [];
  out.push(`═══ Backtest · ${meta.windowDays}d · step ${meta.stepMin}m · ${meta.symbols.join(",")} ═══`);
  out.push(`costs: fee ${meta.feePct}% round-trip + slippage ${meta.slippagePct}%/side · SL-first on ambiguous bars`);
  out.push("");

  out.push(row("strategy", "sig", "fill%", "win%", "exp.R", "PF", "avg"));
  out.push("─".repeat(58));
  const overall = stats("OVERALL", trades);
  for (const s of STRATEGIES) {
    const g = stats(s, trades.filter((t) => t.strategy === s));
    if (g.signals > 0) out.push(statRow(g));
  }
  out.push("─".repeat(58));
  out.push(statRow(overall));
  out.push("");
  out.push(`Max drawdown: ${maxDrawdownR(trades)}R · total R: ${round2(trades.filter((t) => t.filled).reduce((a, b) => a + b.rMultiple, 0))}`);

  // Confidence calibration (filled trades).
  out.push("");
  out.push("Confidence calibration (filled):");
  out.push(row("conf", "sig", "fill%", "win%", "exp.R", "PF", "avg"));
  for (const b of BUCKETS) {
    const g = stats(b, trades.filter((t) => bucketOf(t.confidence) === b));
    if (g.signals > 0) out.push(statRow(g));
  }

  return out.join("\n");
}

// ── formatting helpers ──────────────────────────────────────────────────────

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function pct(n: number | null): string {
  return n === null ? "  — " : `${n.toFixed(1)}%`;
}
function rr(n: number | null): string {
  return n === null ? " — " : n === Infinity ? "  ∞" : n.toFixed(2);
}
function dur(ms: number | null): string {
  if (ms == null) return " — ";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}
function row(...cells: string[]): string {
  const w = [16, 5, 6, 7, 7, 6, 7];
  return cells.map((c, i) => c.padEnd(w[i]!)).join(" ");
}
function statRow(g: GroupStats): string {
  return [
    g.key.padEnd(16),
    String(g.signals).padEnd(5),
    pct(g.fillRatePct).padEnd(6),
    pct(g.winRatePct).padEnd(7),
    (g.expectancyR == null ? " — " : g.expectancyR.toFixed(2)).padEnd(7),
    rr(g.profitFactor).padEnd(6),
    dur(g.avgDurationMs).padEnd(7),
  ].join(" ");
}
