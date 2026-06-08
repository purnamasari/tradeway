// Assembles the analytics queries into one JSON-serializable report and renders it
// as full text (CLI) or a compact digest (Telegram). Surface-agnostic.
import type { Db } from "../db/index.js";
import {
  summary,
  byStrategy,
  byDirection,
  bySymbol,
  byRegime,
  byConfidenceBucket,
  byEdgeState,
  confidenceDecay,
  factorEffectiveness,
  durations,
  type GroupRow,
  type CountsSummary,
  type ConfidenceDecay,
  type FactorEffectiveness,
  type Durations,
} from "./queries.js";

export interface RateRow {
  key: string;
  wins: number;
  losses: number;
  resolved: number;
  winRatePct: number | null;
  avgDurationMs: number | null;
}

export interface AnalyticsReport {
  windowDays: number; // 0 = all-time
  generatedAt: string;
  summary: CountsSummary & { resolved: number; winRatePct: number | null };
  byStrategy: RateRow[];
  byDirection: RateRow[];
  bySymbol: RateRow[];
  byRegime: RateRow[];
  byConfidenceBucket: RateRow[];
  byEdgeState: RateRow[];
  confidenceDecay: ConfidenceDecay;
  factorEffectiveness: FactorEffectiveness;
  durations: Durations;
}

function winRate(wins: number, losses: number): number | null {
  const resolved = wins + losses;
  return resolved === 0 ? null : Math.round((wins / resolved) * 1000) / 10;
}

function toRateRow(g: GroupRow): RateRow {
  return {
    key: g.key,
    wins: g.wins,
    losses: g.losses,
    resolved: g.wins + g.losses,
    winRatePct: winRate(g.wins, g.losses),
    avgDurationMs: g.avgDurationMs,
  };
}

// Calibration buckets sort low→high; everything else by win-rate desc then volume.
const BUCKET_ORDER = ["<60", "60-69", "70-79", "80-89", "90-100"];
function sortRows(rows: RateRow[], asBuckets = false): RateRow[] {
  if (asBuckets) {
    return [...rows].sort((a, b) => BUCKET_ORDER.indexOf(a.key) - BUCKET_ORDER.indexOf(b.key));
  }
  return [...rows].sort(
    (a, b) => (b.winRatePct ?? -1) - (a.winRatePct ?? -1) || b.resolved - a.resolved,
  );
}

export async function buildAnalyticsReport(db: NonNullable<Db>, days: number): Promise<AnalyticsReport> {
  const [s, strat, dir, sym, reg, conf, edge, decay, factors, dur] = await Promise.all([
    summary(db, days),
    byStrategy(db, days),
    byDirection(db, days),
    bySymbol(db, days),
    byRegime(db, days),
    byConfidenceBucket(db, days),
    byEdgeState(db, days),
    confidenceDecay(db, days),
    factorEffectiveness(db, days),
    durations(db, days),
  ]);

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    summary: { ...s, resolved: s.tp + s.sl, winRatePct: winRate(s.tp, s.sl) },
    byStrategy: sortRows(strat.map(toRateRow)),
    byDirection: sortRows(dir.map(toRateRow)),
    bySymbol: sortRows(sym.map(toRateRow)),
    byRegime: sortRows(reg.map(toRateRow)),
    byConfidenceBucket: sortRows(conf.map(toRateRow), true),
    byEdgeState: sortRows(edge.map(toRateRow)),
    confidenceDecay: decay,
    factorEffectiveness: factors,
    durations: dur,
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function pct(n: number | null): string {
  return n === null ? "  —  " : `${n.toFixed(1)}%`;
}
function num(n: number | null, dp = 1): string {
  return n === null || !Number.isFinite(n) ? "—" : n.toFixed(dp);
}
function dur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}
function windowLabel(days: number): string {
  return days <= 0 ? "all-time" : `last ${days}d`;
}

function table(title: string, rows: RateRow[], keyHeader: string): string {
  if (rows.length === 0) return `${title}\n  (no resolved signals)`;
  const keyW = Math.max(keyHeader.length, ...rows.map((r) => r.key.length));
  const head = `  ${keyHeader.padEnd(keyW)}   win%    W/L     avg`;
  const lines = rows.map((r) => {
    const wl = `${r.wins}/${r.losses}`;
    return `  ${r.key.padEnd(keyW)}  ${pct(r.winRatePct).padStart(6)}  ${wl.padStart(7)}  ${dur(r.avgDurationMs).padStart(7)}`;
  });
  return `${title}\n${head}\n${lines.join("\n")}`;
}

/** Full text report for the CLI. */
export function formatReportText(r: AnalyticsReport): string {
  const s = r.summary;
  const out: string[] = [];
  out.push(`═══ Tradeaway Analytics · ${windowLabel(r.windowDays)} ═══`);
  out.push(`generated ${r.generatedAt}`);
  out.push("");
  out.push(
    `Signals: ${s.total} total · ${s.resolved} resolved · ${s.open} open · ${s.expired} expired`,
  );
  out.push(`Overall win-rate: ${pct(s.winRatePct)}  (${s.tp}W / ${s.sl}L)`);
  out.push("");
  out.push(table("By strategy", r.byStrategy, "strategy"));
  out.push("");
  out.push(table("By direction", r.byDirection, "dir"));
  out.push("");
  out.push(table("By symbol", r.bySymbol, "symbol"));
  out.push("");
  out.push(table("By regime", r.byRegime, "regime"));
  out.push("");
  out.push(table("Confidence calibration", r.byConfidenceBucket, "conf"));
  out.push("");
  out.push(table("Edge-monitor validation (terminal edge state)", r.byEdgeState, "edge_state"));
  const d = r.confidenceDecay;
  out.push(
    `  confidence decay (original−live): winners ${num(d.winnersDecay)} · losers ${num(d.losersDecay)}`,
  );
  out.push("");
  const f = r.factorEffectiveness;
  out.push("Factor effectiveness (winners vs losers)");
  out.push(`  funding percentile: ${num(f.winFunding)} vs ${num(f.lossFunding)}`);
  out.push(`  OI z-score:         ${num(f.winOiZscore)} vs ${num(f.lossOiZscore)}`);
  out.push("");
  out.push(`Avg time-to-TP ${dur(r.durations.tpMs)} · time-to-SL ${dur(r.durations.slMs)}`);
  return out.join("\n");
}

/** Compact digest for Telegram. */
export function formatDigest(r: AnalyticsReport): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push(`📊 Tradeaway digest · ${windowLabel(r.windowDays)}`);
  lines.push("");
  lines.push(`Win-rate: ${pct(s.winRatePct)} (${s.tp}W/${s.sl}L) · ${s.open} open · ${s.expired} expired`);

  if (r.byStrategy.length) {
    const top = r.byStrategy.filter((x) => x.resolved > 0);
    if (top.length) {
      lines.push("");
      lines.push("By strategy:");
      for (const x of top) lines.push(`  ${x.key}: ${pct(x.winRatePct)} (${x.wins}/${x.losses})`);
    }
  }

  const edge = r.byEdgeState.filter((x) => x.resolved > 0);
  if (edge.length) {
    lines.push("");
    lines.push("Edge state at close:");
    for (const x of edge) lines.push(`  ${x.key}: ${pct(x.winRatePct)} (${x.wins}/${x.losses})`);
  }

  return lines.join("\n");
}
