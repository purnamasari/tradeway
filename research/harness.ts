// Research backtest harness — DB-cached 15m candles, no network.
//
// Differences from src/backtest/engine.ts (deliberate):
//  - Decisions are made strictly at 15m bar CLOSE; the forward simulation starts
//    at the next bar. (The live replay engine includes the bar containing T,
//    whose OHLC extends past T — a subtle lookahead this harness avoids.)
//  - Hypotheses are explicit rules defined in research/hypotheses.ts, not the
//    live 1m-dependent detectors (the DB cache has 15m candles only).
//  - Each hypothesis runs independently with its own one-open-trade-per-symbol
//    slot, so results are per-hypothesis expectancies, not best-of-portfolio.
//
// All trailing windows (ATR percentile, volume percentile, funding percentile,
// regime, trend) are computed from data at or before the decision bar's close.
import { readFileSync } from "node:fs";
import type { Candle, Direction, RegimeResult, TrendResult } from "../src/types.js";
import type { Rules } from "../src/config.js";
import { classifyRegime } from "../src/regime/engine.js";
import { emaAdxTrendClassifier } from "../src/ai/trend-classifier.js";
import { atr, atrSeries, ema, percentileRank } from "../src/indicators.js";
import { simulateOutcome, type SimCosts, type SimStatus } from "../src/backtest/simulate.js";
import { simulateTrailing } from "./trailing-sim.js";

export interface SymbolCache {
  candles15m: Candle[];
  oi: Array<{ time: number; openInterest: number }>;
  funding: Array<{ time: number; fundingRate: number }>;
}

export function loadSymbolCache(symbol: string): SymbolCache {
  const raw = readFileSync(new URL(`./data/${symbol}.json`, import.meta.url), "utf8");
  return JSON.parse(raw) as SymbolCache;
}

/** Everything a hypothesis may look at when deciding at the close of bar i. */
export interface BarView {
  symbol: string;
  /** Decision bar index into candles15m (bar i has just closed). */
  i: number;
  /** Unix seconds of the decision moment (close of bar i). */
  closeTime: number;
  /** Trailing 15m window ending at bar i (up to 320 bars). */
  c15: Candle[];
  /** FULL 15m array for deep lookbacks (channels, multi-day returns).
   *  Rules MUST only read indices <= i — anything later is future data. */
  c15full: Candle[];
  /** Trailing 1h candles (aggregated from closed 15m bars; last may be partial-hour). */
  c1h: Candle[];
  close: number;
  regime: RegimeResult;
  trend: TrendResult;
  atr15: number; // ATR(14) on 15m as of bar i
  atr1h: number; // ATR(14) on the trailing 1h aggregation
  atrPct: number; // ATR percentile vs trailing 30d
  volPct: number; // bar i volume percentile vs trailing 30d
  fundingPct: number | null; // latest funding percentile vs trailing 30d (null until enough history)
  fundingRate: number | null;
}

export interface HypoSignal {
  direction: Direction;
  entry_low: number;
  entry_high: number;
  sl: number;
  tp: number; // ignored when trail_dist is set
  /** When set, exit via chandelier trail at this distance instead of a fixed TP. */
  trail_dist?: number;
  entry_ttl_ms: number;
  outcome_ttl_ms: number;
}

export interface Hypothesis {
  name: string;
  rule: (v: BarView) => HypoSignal | null;
}

export interface ResearchTrade {
  hypothesis: string;
  symbol: string;
  direction: Direction;
  detectedAt: number; // unix ms (bar close)
  month: string; // YYYY-MM
  regime: string;
  trend: string;
  status: SimStatus | "TRAIL";
  filled: boolean;
  rMultiple: number; // net of taker costs (simulateOutcome)
  grossR: number; // before costs
  costR: number; // taker-model cost in R deducted by the simulator
  riskPct: number; // |entry − SL| as % of entry (drives the cost hurdle)
  durationMs: number | null;
}

const BARS_30D = 30 * 96; // trailing 30d of 15m bars
const WARMUP_BARS = BARS_30D; // need a full percentile window before trading

/** Aggregate closed 15m bars [0..i] into 1h candles (UTC hour buckets). */
function aggregate1h(c15: Candle[], upto: number): Candle[] {
  const out: Candle[] = [];
  for (let j = 0; j <= upto; j++) {
    const c = c15[j]!;
    const bucket = c.time - (c.time % 3600);
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

export function replayResearch(
  symbol: string,
  data: SymbolCache,
  hypotheses: Hypothesis[],
  rules: Rules,
  costs: SimCosts,
): ResearchTrade[] {
  const c15 = data.candles15m;
  const trades: ResearchTrade[] = [];
  if (c15.length < WARMUP_BARS + 100) return trades;

  // Causal precomputations (each index depends only on data at or before it).
  const fullAtr = atrSeries(c15, rules.regime.atr_period);
  const volumes = c15.map((c) => c.volume);

  // Incrementally maintained 1h aggregation.
  let c1h: Candle[] = aggregate1h(c15, WARMUP_BARS - 1);

  // Per-hypothesis one-open-trade-per-symbol slot (unix sec until which it's busy).
  const openUntil = new Map<string, number>(hypotheses.map((h) => [h.name, 0]));

  for (let i = WARMUP_BARS; i < c15.length; i++) {
    const bar = c15[i]!;
    // extend 1h aggregation with bar i
    const bucket = bar.time - (bar.time % 3600);
    const lastH = c1h[c1h.length - 1]!;
    if (lastH.time === bucket) {
      lastH.high = Math.max(lastH.high, bar.high);
      lastH.low = Math.min(lastH.low, bar.low);
      lastH.close = bar.close;
      lastH.volume += bar.volume;
    } else {
      c1h.push({ time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    }

    const closeTime = bar.time + 900;
    const win15 = c15.slice(Math.max(0, i - 319), i + 1);
    const win1h = c1h.slice(-120);

    const atrHist = fullAtr.slice(Math.max(0, i - BARS_30D), i + 1).filter(Number.isFinite);
    const regime = classifyRegime(win15, rules.regime, atrHist);

    const closes1h = win1h.map((c) => c.close);
    const trend = emaAdxTrendClassifier(win1h, ema(closes1h, rules.regime.ema_fast), ema(closes1h, rules.regime.ema_slow));

    const atr15 = fullAtr[i]!;
    const volWindow = volumes.slice(Math.max(0, i - BARS_30D), i); // strictly before bar i
    const volPct = percentileRank(bar.volume, volWindow);

    // Funding: latest event at/before closeTime, percentile vs trailing 30d of events.
    let fundingRate: number | null = null;
    let fundingPct: number | null = null;
    {
      const fu = data.funding;
      let lo = 0, hi = fu.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (fu[m]!.time <= closeTime) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx >= 0) {
        fundingRate = fu[idx]!.fundingRate;
        const hist = fu.slice(Math.max(0, idx - 90), idx + 1).map((f) => f.fundingRate);
        if (hist.length >= 30) fundingPct = percentileRank(fundingRate, hist);
      }
    }

    const view: BarView = {
      symbol, i, closeTime, c15: win15, c15full: c15, c1h: win1h, close: bar.close,
      regime, trend, atr15, atr1h: atr(win1h, 14), atrPct: regime.atrPercentile, volPct, fundingPct, fundingRate,
    };

    for (const h of hypotheses) {
      if (closeTime <= openUntil.get(h.name)!) continue;
      const sig = h.rule(view);
      if (!sig) continue;

      const fwdBars = Math.ceil((sig.entry_ttl_ms + sig.outcome_ttl_ms) / 900_000) + 4;
      const forward = c15.slice(i + 1, i + 1 + fwdBars);
      const sim = sig.trail_dist
        ? simulateTrailing(
            {
              direction: sig.direction,
              entry_low: sig.entry_low,
              entry_high: sig.entry_high,
              sl: sig.sl,
              trail_dist: sig.trail_dist,
              detected_at: closeTime * 1000,
              entry_ttl_ms: sig.entry_ttl_ms,
              outcome_ttl_ms: sig.outcome_ttl_ms,
            },
            forward,
            costs,
          )
        : simulateOutcome(
            {
              strategy: "momentum", // unused: TTL overrides supplied
              direction: sig.direction,
              entry_low: sig.entry_low,
              entry_high: sig.entry_high,
              sl: sig.sl,
              tp: sig.tp,
              detected_at: closeTime * 1000,
              entry_ttl_ms: sig.entry_ttl_ms,
              outcome_ttl_ms: sig.outcome_ttl_ms,
            },
            forward,
            costs,
          );

      const entryMid = (sig.entry_low + sig.entry_high) / 2;
      const risk = Math.abs(entryMid - sig.sl) || 1e-9;
      const costR = sim.filled ? (entryMid * ((costs.feePct + 2 * costs.slippagePct) / 100)) / risk : 0;
      trades.push({
        hypothesis: h.name,
        symbol,
        direction: sig.direction,
        detectedAt: closeTime * 1000,
        month: new Date(closeTime * 1000).toISOString().slice(0, 7),
        regime: regime.regime,
        trend: trend.trend,
        status: sim.status,
        filled: sim.filled,
        rMultiple: sim.rMultiple,
        grossR: sim.rMultiple + costR,
        costR,
        riskPct: (risk / entryMid) * 100,
        durationMs: sim.durationMs,
      });

      openUntil.set(h.name, sim.closedAt ?? closeTime + sig.entry_ttl_ms / 1000);
    }
  }
  return trades;
}
