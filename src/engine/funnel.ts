// Gate funnel — in-process observability for "why was no signal generated?".
// Every strategy evaluation is recorded as either a signal or a rejection at a
// named stage. Combined with a strategy's ordered `stages` pipeline, this yields
// a cumulative funnel that pinpoints the bottleneck gate:
//
//   SMC  evaluated=10000  signals=14
//     regime : reached 10000  passed 4200  (failed 5800)   ← biggest drop
//     bos    : reached  4200  passed  900  (failed 3300)
//     ...
//
// Pure counters, reset on restart (like telemetry). No trading logic here.
export interface StrategyFunnel {
  evaluated: number;
  signals: number;
  /** stage label → count of evaluations that FAILED at that stage. */
  failByStage: Record<string, number>;
}

export interface FunnelStageRow {
  stage: string;
  reached: number;
  passed: number;
  failed: number;
}

export interface FunnelReport {
  strategyId: string;
  evaluated: number;
  signals: number;
  /** Cumulative rows in pipeline order (present only when the stage order is known). */
  stages: FunnelStageRow[];
  /** Failures at stages not in the declared pipeline (defensive; usually empty). */
  other: Record<string, number>;
}

const counters = new Map<string, StrategyFunnel>();

function slot(strategyId: string): StrategyFunnel {
  let f = counters.get(strategyId);
  if (!f) {
    f = { evaluated: 0, signals: 0, failByStage: {} };
    counters.set(strategyId, f);
  }
  return f;
}

export const funnel = {
  /** One bar's evaluation began for this strategy (slot was free). */
  evaluated(strategyId: string): void {
    slot(strategyId).evaluated++;
  },
  /** The evaluation produced an entry intent. */
  signal(strategyId: string): void {
    slot(strategyId).signals++;
  },
  /** The evaluation was rejected at `stage` (or "unknown" when untagged). */
  rejected(strategyId: string, stage: string | undefined): void {
    const f = slot(strategyId);
    const key = stage ?? "unknown";
    f.failByStage[key] = (f.failByStage[key] ?? 0) + 1;
  },
  reset(): void {
    counters.clear();
  },
};

/** Build a cumulative funnel for one strategy given its ordered pipeline. */
export function reportFor(strategyId: string, pipeline?: string[]): FunnelReport {
  const f = counters.get(strategyId) ?? { evaluated: 0, signals: 0, failByStage: {} };
  const stages: FunnelStageRow[] = [];
  const used = new Set<string>();
  let reached = f.evaluated;
  for (const stage of pipeline ?? []) {
    const failed = f.failByStage[stage] ?? 0;
    used.add(stage);
    const passed = reached - failed;
    stages.push({ stage, reached, passed, failed });
    reached = passed; // survivors flow into the next gate
  }
  const other: Record<string, number> = {};
  for (const [stage, n] of Object.entries(f.failByStage)) {
    if (!used.has(stage)) other[stage] = n;
  }
  return { strategyId, evaluated: f.evaluated, signals: f.signals, stages, other };
}

/** Snapshot for the /health engine key. */
export function funnelSnapshot(pipelines: Record<string, string[] | undefined>): FunnelReport[] {
  const ids = new Set([...counters.keys(), ...Object.keys(pipelines)]);
  return [...ids].map((id) => reportFor(id, pipelines[id]));
}

/** Human-readable funnel, e.g. for logs or the explain CLI. */
export function renderFunnel(reports: FunnelReport[]): string {
  if (reports.length === 0) return "(no evaluations recorded yet)";
  const out: string[] = [];
  for (const r of reports) {
    out.push(`${r.strategyId}  evaluated=${r.evaluated}  signals=${r.signals}`);
    for (const s of r.stages) {
      const pct = r.evaluated > 0 ? ((s.passed / r.evaluated) * 100).toFixed(1) : "0.0";
      out.push(
        `  ${s.stage.padEnd(8)}: reached ${String(s.reached).padStart(7)}  passed ${String(s.passed).padStart(7)}  (failed ${String(s.failed).padStart(7)})  ${pct}% of evals`,
      );
    }
    for (const [stage, n] of Object.entries(r.other)) {
      out.push(`  ${stage.padEnd(8)}: failed ${n} (stage not in declared pipeline)`);
    }
  }
  return out.join("\n");
}
