// Per-minute trade assessment — the stateless core of the trade manager.
// Takes one open trade + a fresh MarketContext and produces the full picture:
// health, PnL, observations/warnings, suggested actions, events, adaptive stop,
// live path probabilities, and emergency-exit conditions. All persistence,
// throttling, and notification policy live in manager.ts; this file is pure so
// it can be tested offline against crafted candles.
import type {
  Direction,
  MarketContext,
  ManagementEvent,
  PathProbabilities,
  TradeAssessment,
} from "../types.js";
import type { Rules } from "../config.js";
import { classifyRegime } from "../regime/engine.js";
import { buildSR } from "../strategy/sr-engine.js";
import { percentileRank } from "../indicators.js";
import { detectRejection, detectMomentumDecay, detectLiquidityEvent } from "./detectors.js";
import { scoreTradeHealth, steppingWithTrade } from "./health.js";
import { suggestStop } from "./stops.js";
import { estimatePaths } from "./paths.js";

/** The slice of an outcome row the assessment needs (decoupled for testability). */
export interface ManagedTrade {
  symbol: string;
  direction: Direction;
  strategy: string;
  source: string; // 'signal' | 'bybit'
  entryPrice: number;
  sl: number | null; // current stop (0/null = none set)
  tp: number | null; // 0/null = none set
  /** |entry − original SL| captured at fill time; null when unknown. */
  initialRisk: number | null;
  entryConfidence: number | null;
  /** Edge monitor's latest recompute (signal trades only). */
  currentConfidence: number | null;
  edgeState: string;
}

export function assessTrade(
  trade: ManagedTrade,
  ctx: MarketContext,
  rules: Rules,
): TradeAssessment {
  const m = rules.management;
  const sign = trade.direction === "long" ? 1 : -1;
  const price = ctx.candles1m.at(-1)?.close ?? ctx.candles15m.at(-1)!.close;

  const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);
  const sr = buildSR(ctx.candles15m, price);
  const rejection = detectRejection(ctx.candles1m, trade.direction, sr, m);
  const decay = detectMomentumDecay(ctx.candles15m, trade.direction, m);
  const liquidity = detectLiquidityEvent(ctx.candles1m, trade.direction, m);

  const hasSl = trade.sl != null && trade.sl > 0;
  const hasTp = trade.tp != null && trade.tp > 0;
  const initialRisk =
    trade.initialRisk ?? (hasSl ? Math.abs(trade.entryPrice - trade.sl!) : null);

  const pnlPct = (sign * (price - trade.entryPrice) * 100) / trade.entryPrice;
  const pnlR =
    initialRisk != null && initialRisk > 0
      ? round2((sign * (price - trade.entryPrice)) / initialRisk)
      : null;

  const health = scoreTradeHealth(
    {
      direction: trade.direction,
      entry: trade.entryPrice,
      sl: hasSl ? trade.sl : null,
      price,
      initialRisk,
      candles15m: ctx.candles15m,
      candles1h: ctx.candles1h,
      sr,
      volumeHistory: ctx.volumeHistory,
      decay,
      rejection,
      emaFast: rules.regime.ema_fast,
      emaSlow: rules.regime.ema_slow,
    },
    m,
  );

  const stop = suggestStop(
    {
      direction: trade.direction,
      entry: trade.entryPrice,
      currentSl: hasSl ? trade.sl : null,
      price,
      candles15m: ctx.candles15m,
      sr,
      regime: regime.regime,
      initialRisk,
    },
    m,
  );

  // ── Live path probabilities ───────────────────────────────────────────────
  let paths: PathProbabilities | null = null;
  if (hasSl && hasTp) {
    const lastVol = ctx.candles15m.at(-1)?.volume ?? 0;
    const volWindow =
      ctx.volumeHistory && ctx.volumeHistory.length >= 50
        ? ctx.volumeHistory
        : ctx.candles15m.map((c) => c.volume).slice(-120);
    const strengthSource = trade.currentConfidence ?? health.total;
    paths = estimatePaths({
      direction: trade.direction,
      price,
      entry: trade.entryPrice,
      sl: trade.sl!,
      tp: trade.tp!,
      strength: (health.total * 0.5 + strengthSource * 0.5) / 100,
      strategy: trade.strategy,
      volumePercentile: percentileRank(lastVol, volWindow),
      momentumScore: health.components.momentum,
    });
  }

  // ── Observations & warnings ───────────────────────────────────────────────
  const observations: string[] = [];
  const warnings: string[] = [];

  if (health.components.structure >= 65) observations.push("Structure intact");
  else if (health.components.structure < 40) warnings.push("Structure deteriorating");

  if (steppingWithTrade(ctx.candles15m.slice(-15), trade.direction)) {
    observations.push(trade.direction === "long" ? "Higher lows maintained" : "Lower highs maintained");
  }

  const protective = trade.direction === "long" ? sr.support : sr.resistance;
  if (protective && health.components.structure >= 50) {
    observations.push(
      trade.direction === "long"
        ? `Buyers defending support ${fmt(protective.price)}`
        : `Sellers defending resistance ${fmt(protective.price)}`,
    );
  }

  if (health.components.trend_alignment >= 85) observations.push("1h trend aligned");
  else if (health.components.trend_alignment <= 20) warnings.push("1h trend has turned against the trade");

  if (decay.fading) warnings.push(`Momentum fading (${decay.signals.join(", ")})`);
  else if (decay.signals.length === 1) warnings.push(`Momentum slowing (${decay.signals[0]})`);

  if (rejection.risk) warnings.push(`Rejection risk (${rejection.signals.join("; ")})`);

  // A far level within reach is worth flagging even before rejection appears.
  const farLevel = trade.direction === "long" ? sr.resistance : sr.support;
  if (farLevel && Math.abs(farLevel.price - price) / price < 0.01) {
    warnings.push(`${farLevel.kind === "resistance" ? "Resistance" : "Support"} ${fmt(farLevel.price)} nearby`);
  }

  if (!hasSl) warnings.push("No stop-loss set on this position");
  if (trade.edgeState === "EDGE_WEAKENING") warnings.push("Signal edge weakening");

  // ── Suggested actions (ordered, most protective first) ───────────────────
  const actions: string[] = [];
  const slBeyondEntry = hasSl && sign * (trade.sl! - trade.entryPrice) >= 0;

  if (!hasSl && stop) {
    actions.push(`Set a stop at ${stop.price} (${stop.reasons[0]})`);
  } else if (pnlR != null && pnlR >= m.breakeven_at_r && !slBeyondEntry) {
    actions.push(`Move SL to breakeven (${fmt(trade.entryPrice)}) — trade is +${pnlR}R`);
  } else if (stop) {
    actions.push(`Move SL to ${stop.price} (${stop.reasons.join(", ")})`);
  }

  if (pnlR != null && pnlR >= m.lock_at_r) {
    actions.push(`Take ${Math.round(m.lock_fraction * 100)}% partial profit — +${pnlR}R reached`);
  } else if (rejection.risk && pnlPct > 0) {
    actions.push(`Take ${Math.round(m.resistance_partial_fraction * 100)}% partial while price is rejected`);
  } else if (decay.fading && pnlPct > 0) {
    actions.push("Consider a partial exit — momentum is fading");
  }

  if (hasTp && actions.length > 0) {
    actions.push(`Hold remaining position for TP ${fmt(trade.tp!)}`);
  }

  // ── Emergency exit conditions (live) ──────────────────────────────────────
  const emergencyLevel = protective ? fmt(protective.price) : hasSl ? fmt(trade.sl!) : null;
  const emergency: string[] = [];
  if (emergencyLevel) {
    emergency.push(
      `Structure breaks (15m close ${trade.direction === "long" ? "below" : "above"} ${emergencyLevel})`,
    );
  }
  emergency.push(
    trade.direction === "long"
      ? "Volume spike sells into support"
      : "Volume spike buys into resistance",
  );
  if (trade.currentConfidence != null) {
    emergency.push(`Confidence drops below ${m.emergency_confidence_floor}`);
  }

  // ── Events (stateless; manager applies cooldowns/latches) ─────────────────
  const events: ManagementEvent[] = [];

  if (rejection.risk) {
    events.push({
      kind: "rejection_risk",
      severity: "warning",
      title: "Rejection risk increasing",
      happened: rejection.signals,
      matters: `Price is being refused at ${farLevel ? fmt(farLevel.price) : "the level"}; follow-through is stalling and these trades often drift back without hitting TP.`,
      actions: actions.slice(0, 2),
    });
  }

  if (decay.fading) {
    events.push({
      kind: "momentum_decay",
      severity: "warning",
      title: "Momentum fading",
      happened: decay.signals,
      matters: "The move that justified this entry is exhausting; expectancy now favors protecting what the trade has earned.",
      actions: actions.length > 0 ? actions.slice(0, 2) : ["Consider partial exit", "Tighten stop"],
    });
  }

  if (liquidity.event && liquidity.bias === "against") {
    events.push({
      kind: liquidity.event,
      severity: "warning",
      title:
        liquidity.event === "breakout_trap"
          ? "Breakout trap detected"
          : liquidity.event === "stop_hunt"
            ? "Stop hunt detected"
            : "Liquidity sweep detected",
      happened: liquidity.detail,
      matters: "Liquidity was taken against the trade — moves like this frequently reverse the prior push.",
      actions: ["Reduce position size", "Protect gains — tighten stop"],
    });
  }

  if (trade.edgeState === "INVALIDATED") {
    events.push({
      kind: "thesis_invalidated",
      severity: "critical",
      title: "Signal thesis invalidated",
      happened: ["The edge monitor has invalidated the original signal thesis"],
      matters: "The reason for being in this trade no longer exists; from here it is price risk with no edge.",
      actions: ["Exit or reduce to a minimal runner", "If holding: stop to breakeven at minimum"],
    });
  }

  const confCollapsed =
    trade.currentConfidence != null && trade.currentConfidence < m.emergency_confidence_floor;
  if (health.band === "exit_candidate" || confCollapsed) {
    const happened: string[] = [];
    if (health.band === "exit_candidate") happened.push(`Trade health collapsed to ${health.total}/100`);
    if (confCollapsed) happened.push(`Live confidence ${trade.currentConfidence} below floor ${m.emergency_confidence_floor}`);
    events.push({
      kind: "emergency_exit",
      severity: "critical",
      title: "Emergency exit conditions met",
      happened,
      matters: "Multiple dimensions of this trade have failed at once; statistically these positions bleed into the stop.",
      actions: ["Exit immediately"],
    });
  }

  return {
    symbol: trade.symbol,
    direction: trade.direction,
    price: roundPrice(price),
    pnlPct: round2(pnlPct),
    pnlR,
    health,
    entryConfidence: trade.entryConfidence,
    currentConfidence: trade.currentConfidence,
    observations,
    warnings,
    actions,
    events,
    stop,
    paths,
    emergency,
  };
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
  return Number(n.toFixed(dp)).toString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundPrice(n: number): number {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
