// Backtest replay engine. Walks historical data forward, rebuilds a MarketContext
// at each step, runs the REAL detector pipeline (deterministic — no Gemini, no
// cache, no DB), and simulates each fired signal's outcome. Read-only reuse of the
// live code so backtest signals match what the live scanner would have produced.
import type { Candle, MarketContext, Signal, StrategyKind, Direction } from "../types.js";
import { ENTRY_TTL } from "../types.js";
import type { Rules, GlobalConfig } from "../config.js";
import { classifyRegime } from "../regime/engine.js";
import { emaAdxTrendClassifier } from "../ai/trend-classifier.js";
import { buildSR } from "../strategy/sr-engine.js";
import { detectLiquiditySweep } from "../strategy/liquidity-sweep.js";
import { detectTrendPullback } from "../strategy/trend-pullback.js";
import { detectSqueeze } from "../strategy/squeeze.js";
import { detectMomentum } from "../strategy/momentum.js";
import { ema, atrSeries } from "../indicators.js";
import {
  fetchCandlesRange,
  fetchFundingHistoryRange,
  fetchOIHistoryRange,
} from "../data/bybit.js";
import { simulateOutcome, type SimCosts, type SimStatus } from "./simulate.js";

export interface SymbolData {
  candles1m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  funding: Array<{ time: number; fundingRate: number }>;
  oi: Array<{ time: number; openInterest: number }>;
}

export interface BacktestTrade {
  symbol: string;
  strategy: StrategyKind;
  direction: Direction;
  detectedAt: number; // ms
  confidence: number;
  setup_quality: number;
  regime: string;
  trend: string;
  rr: number;
  status: SimStatus;
  filled: boolean;
  rMultiple: number;
  durationMs: number | null;
}

export interface ReplayOpts {
  rules: Rules;
  global: GlobalConfig;
  minConfidence: number; // per-symbol gate
  stepMin: number;
  costs: SimCosts;
}

// ── Window helpers (binary search on sorted-asc arrays) ──────────────────────

/** Index of the last element with time ≤ t, or -1. */
function lastIdxLE<T extends { time: number }>(arr: T[], t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function windowUpTo<T extends { time: number }>(arr: T[], t: number, maxLen: number): T[] {
  const idx = lastIdxLE(arr, t);
  if (idx < 0) return [];
  return arr.slice(Math.max(0, idx - maxLen + 1), idx + 1);
}

// ── Context reconstruction ───────────────────────────────────────────────────

function buildContextAt(symbol: string, data: SymbolData, tSec: number, rules: Rules): MarketContext | null {
  const candles1m = windowUpTo(data.candles1m, tSec, 320);
  const candles15m = windowUpTo(data.candles15m, tSec, 220);
  const candles1h = windowUpTo(data.candles1h, tSec, 120);
  if (candles15m.length < 60 || candles1h.length < 60 || candles1m.length < 50) return null;

  const fundingWin = windowUpTo(data.funding, tSec, 500);
  const oiWin = windowUpTo(data.oi, tSec, 500);
  const atrHistory = atrSeries(candles15m, rules.regime.atr_period).filter(Number.isFinite);

  return {
    symbol,
    candles1m,
    candles15m,
    candles1h,
    fundingRate: fundingWin.at(-1)?.fundingRate ?? null,
    openInterest: oiWin.at(-1)?.openInterest ?? null,
    fundingHistory: fundingWin.map((f) => f.fundingRate),
    oiHistory: oiWin.map((o) => o.openInterest),
    atrHistory,
    volumeHistory: candles15m.map((c) => c.volume),
    historyConfidence: Math.min(1, fundingWin.length / 100),
  };
}

function combined(s: Signal): number {
  return s.confidence * 0.6 + s.setup_quality * 0.4;
}

// ── Per-symbol replay (pure — testable without network) ──────────────────────

export function replaySymbol(symbol: string, data: SymbolData, opts: ReplayOpts): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const { rules, global, minConfidence, stepMin, costs } = opts;
  if (data.candles1m.length < 320 || data.candles15m.length < 70 || data.candles1h.length < 70) {
    return trades;
  }

  const stepSec = stepMin * 60;
  // Start once enough warmup history exists for every timeframe.
  const firstT = Math.max(
    data.candles15m[60]!.time,
    data.candles1h[60]!.time,
    data.candles1m[300]!.time,
  );
  const endT = data.candles1m.at(-1)!.time;
  let openUntil = 0;

  for (let T = firstT; T <= endT; T += stepSec) {
    if (T <= openUntil) continue;

    const ctx = buildContextAt(symbol, data, T, rules);
    if (!ctx) continue;

    const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);
    const closes1h = ctx.candles1h.map((c) => c.close);
    const ema20 = ema(closes1h, rules.regime.ema_fast);
    const ema50 = ema(closes1h, rules.regime.ema_slow);
    const trend = emaAdxTrendClassifier(ctx.candles1h, ema20, ema50);
    const price = ctx.candles15m.at(-1)!.close;
    const sr = buildSR(ctx.candles15m, price);

    const candidates = [
      detectLiquiditySweep(ctx, regime, trend, sr, rules),
      detectTrendPullback(ctx, regime, trend, sr, rules),
      detectSqueeze(ctx, regime, trend, sr, rules),
      detectMomentum(ctx, regime, trend, sr, rules),
    ]
      .map((r) => r.signal)
      .filter((s): s is Signal => s !== null);
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => combined(b) - combined(a));
    const signal = candidates[0]!;

    // Same gates as the live scanner.
    if (signal.confidence < minConfidence) continue;
    if (signal.setup_quality < global.min_setup_quality) continue;
    if (signal.rr < global.min_rr) continue;

    // Forward 1m candles for the fill simulation (bounded: entry + outcome window).
    const fwdIdx = lastIdxLE(data.candles1m, T) + 1;
    const forward = data.candles1m.slice(fwdIdx, fwdIdx + 700);
    const sim = simulateOutcome({ ...signal, detected_at: T * 1000 }, forward, costs);

    trades.push({
      symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      detectedAt: T * 1000,
      confidence: signal.confidence,
      setup_quality: signal.setup_quality,
      regime: regime.regime,
      trend: trend.trend,
      rr: signal.rr,
      status: sim.status,
      filled: sim.filled,
      rMultiple: sim.rMultiple,
      durationMs: sim.durationMs,
    });

    // Occupy the symbol slot until the trade resolves (mirrors one-active-per-symbol).
    openUntil = sim.closedAt ?? T + ENTRY_TTL[signal.strategy] / 1000;
  }

  return trades;
}

// ── Fetch (uses the existing range fetchers; runs where Bybit is reachable) ──

export async function fetchSymbolData(
  symbol: string,
  category: string,
  startMs: number,
  endMs: number,
): Promise<SymbolData> {
  const [candles1m, candles15m, candles1h, funding, oi] = await Promise.all([
    fetchCandlesRange(symbol, "1m", category, startMs, endMs),
    fetchCandlesRange(symbol, "15m", category, startMs, endMs),
    fetchCandlesRange(symbol, "1h", category, startMs, endMs),
    fetchFundingHistoryRange(symbol, category, startMs, endMs),
    fetchOIHistoryRange(symbol, category, "1h", startMs, endMs),
  ]);
  return { candles1m, candles15m, candles1h, funding, oi };
}

export interface BacktestOpts extends Omit<ReplayOpts, "minConfidence"> {
  symbols: Array<{ symbol: string; minConfidence: number }>;
  category: string;
  startMs: number;
  endMs: number;
  onProgress?: (symbol: string, trades: number) => void;
}

export async function runBacktest(opts: BacktestOpts): Promise<BacktestTrade[]> {
  const all: BacktestTrade[] = [];
  for (const { symbol, minConfidence } of opts.symbols) {
    const data = await fetchSymbolData(symbol, opts.category, opts.startMs, opts.endMs);
    const trades = replaySymbol(symbol, data, {
      rules: opts.rules,
      global: opts.global,
      minConfidence,
      stepMin: opts.stepMin,
      costs: opts.costs,
    });
    opts.onProgress?.(symbol, trades.length);
    all.push(...trades);
  }
  return all;
}
