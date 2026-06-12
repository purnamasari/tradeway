// Engine telemetry — in-process counters for observability and the
// engine-vs-legacy comparison. Reset on restart (cumulative history lives in
// the DB rows themselves); exposed through GET /health (engine key) and logs.
export interface EngineTelemetry {
  startedAt: string;
  cycles: number;
  lastCycleMs: number | null;
  avgCycleMs: number | null;
  barsProcessed: number; // (symbol, new-bar) decision passes
  signalsGenerated: number; // entry decisions with enter=true
  entriesVetoed: number; // risk-engine vetoes
  positionsOpened: number; // intents accepted (PENDING_ENTRY created)
  fills: number;
  stopMoves: number;
  exits: Record<string, number>; // terminal status → count
  errors: number;
  lastBarTime: Record<string, string>; // symbol → ISO of last processed bar
}

const t: EngineTelemetry = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  lastCycleMs: null,
  avgCycleMs: null,
  barsProcessed: 0,
  signalsGenerated: 0,
  entriesVetoed: 0,
  positionsOpened: 0,
  fills: 0,
  stopMoves: 0,
  exits: {},
  errors: 0,
  lastBarTime: {},
};

export const telemetry = {
  cycleDone(ms: number): void {
    t.cycles++;
    t.lastCycleMs = Math.round(ms);
    t.avgCycleMs = t.avgCycleMs == null ? Math.round(ms) : Math.round(t.avgCycleMs * 0.9 + ms * 0.1);
  },
  barProcessed(symbol: string, barTimeSec: number): void {
    t.barsProcessed++;
    t.lastBarTime[symbol] = new Date(barTimeSec * 1000).toISOString();
  },
  signal(): void {
    t.signalsGenerated++;
  },
  veto(): void {
    t.entriesVetoed++;
  },
  opened(): void {
    t.positionsOpened++;
  },
  fill(): void {
    t.fills++;
  },
  stopMove(): void {
    t.stopMoves++;
  },
  exit(status: string): void {
    t.exits[status] = (t.exits[status] ?? 0) + 1;
  },
  error(): void {
    t.errors++;
  },
};

export function getEngineTelemetry(): EngineTelemetry {
  return { ...t, exits: { ...t.exits }, lastBarTime: { ...t.lastBarTime } };
}
