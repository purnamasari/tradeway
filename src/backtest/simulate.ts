// Outcome simulation for the backtester. Given a fired signal and the 1m candles
// that follow, walk forward and decide whether it filled and then hit TP, SL, or
// expired — using 1m highs/lows, SL-first on an ambiguous candle (pessimistic),
// with fees + slippage deducted so expectancy is honest.
import type { Candle, Direction, StrategyKind } from "../types.js";
import { ENTRY_TTL, OUTCOME_TTL } from "../types.js";

export type SimStatus = "TP" | "SL" | "EXPIRED" | "NO_FILL";

export interface SimCosts {
  feePct: number; // round-trip taker fee, percent of notional (e.g. 0.11)
  slippagePct: number; // per side, percent (e.g. 0.02)
}

export interface SimResult {
  status: SimStatus;
  filled: boolean;
  entryPrice: number;
  exitPrice: number | null;
  rMultiple: number; // realized R after costs (0 for NO_FILL)
  enteredAt: number | null; // unix seconds
  closedAt: number | null; // unix seconds
  durationMs: number | null;
}

export interface SimSignal {
  strategy: StrategyKind;
  direction: Direction;
  entry_low: number;
  entry_high: number;
  sl: number;
  tp: number;
  detected_at: number; // unix ms
}

/**
 * Simulate a signal forward. `forward` = 1m candles with time strictly after the
 * signal, oldest-first. Pure; no I/O.
 */
export function simulateOutcome(signal: SimSignal, forward: Candle[], costs: SimCosts): SimResult {
  const isLong = signal.direction === "long";
  const entryMid = (signal.entry_low + signal.entry_high) / 2;
  const entryTtlSec = (ENTRY_TTL[signal.strategy] ?? 3_600_000) / 1000;
  const outcomeTtlSec = (OUTCOME_TTL[signal.strategy] ?? 21_600_000) / 1000;
  const tSec = Math.floor(signal.detected_at / 1000);
  const entryDeadline = tSec + entryTtlSec;

  const risk = Math.abs(entryMid - signal.sl) || 1e-9;
  const rrTarget = Math.abs(signal.tp - entryMid) / risk;
  // Cost as a fraction of R: (round-trip fee + entry+exit slippage) on notional ÷ risk.
  const costR = (entryMid * ((costs.feePct + 2 * costs.slippagePct) / 100)) / risk;

  // ── Phase 1: wait for the entry band to be touched ──────────────────────────
  let entryIdx = -1;
  for (let i = 0; i < forward.length; i++) {
    const c = forward[i]!;
    if (c.time > entryDeadline) break;
    if (c.low <= signal.entry_high && c.high >= signal.entry_low) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx === -1) {
    return { status: "NO_FILL", filled: false, entryPrice: entryMid, exitPrice: null, rMultiple: 0, enteredAt: null, closedAt: null, durationMs: null };
  }

  const enteredAt = forward[entryIdx]!.time;
  const closeDeadline = enteredAt + outcomeTtlSec;

  const mk = (status: SimStatus, exitPrice: number, closedAt: number, grossR: number): SimResult => ({
    status,
    filled: true,
    entryPrice: entryMid,
    exitPrice,
    rMultiple: grossR - costR,
    enteredAt,
    closedAt,
    durationMs: (closedAt - enteredAt) * 1000,
  });

  // ── Phase 2: resolve TP/SL (SL checked first → SL-first on ambiguous bars) ──
  let lastTime = enteredAt;
  let lastClose = forward[entryIdx]!.close;
  for (let i = entryIdx; i < forward.length; i++) {
    const c = forward[i]!;
    if (c.time > closeDeadline) break;
    lastTime = c.time;
    lastClose = c.close;
    const hitSL = isLong ? c.low <= signal.sl : c.high >= signal.sl;
    const hitTP = isLong ? c.high >= signal.tp : c.low <= signal.tp;
    if (hitSL) return mk("SL", signal.sl, c.time, -1);
    if (hitTP) return mk("TP", signal.tp, c.time, rrTarget);
  }

  // ── Expired: mark to the last close within the window ───────────────────────
  const markR = (isLong ? lastClose - entryMid : entryMid - lastClose) / risk;
  return mk("EXPIRED", lastClose, lastTime, markR);
}
