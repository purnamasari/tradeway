// Engine cycle — the bar-close driver. Runs on the scheduler (60s); decisions
// happen only when a new 15m bar has CLOSED for a symbol, with a cheap
// standing-stop tick check in between. The cycle is strategy-agnostic: it
// iterates the registry and speaks only the engine interfaces.
//
// Candle access goes through MarketDataProvider (DB-backed with live top-up
// in production) — strategies never touch research files or raw REST.
//
// Per symbol, per cycle:
//   no new bar  → evaluateTick on open positions (stop/target safety only)
//   new bar     → for each open position:  evaluateBar (standing exits)
//                   → strategy.updateState → strategy.evaluateExit → apply
//                 for each free (symbol, strategy) slot: strategy.evaluateEntry
//                   → risk.size → create + persist + notify
import type { Rules } from "../config.js";
import type { MarketDataProvider } from "../data/provider.js";
import { classifyRegime } from "../regime/engine.js";
import { emaAdxTrendClassifier } from "../ai/trend-classifier.js";
import { atr, atrSeries, ema } from "../indicators.js";
import { logger } from "../logger.js";
import type { AccountState, StrategyContext } from "./types.js";
import type { StrategyRegistry } from "./strategy.js";
import { createPosition, type Position, type PositionStore } from "./position.js";
import { applyExitDecision, evaluateBar, evaluateTick, type PositionTransition } from "./exit.js";
import type { RiskEngine } from "./risk.js";
import type { NotificationEngine, NotificationEvent } from "./notify.js";
import { telemetry } from "./telemetry.js";

const BAR_SEC = 900; // decision timeframe: 15m
const CONTEXT_HEADROOM = 512; // bars beyond minBars for indicator convergence

export interface EngineCycleDeps {
  store: PositionStore;
  registry: StrategyRegistry;
  risk: RiskEngine;
  notifications: NotificationEngine;
  data: MarketDataProvider;
  rules: Rules;
  symbols: string[];
  /** Paper/account equity for sizing (advisory mode ignores it). */
  equity: number;
}

/** Mutable per-process cycle state (last processed bar per symbol). */
export interface EngineRuntime {
  lastBarTime: Map<string, number>;
}

export function createEngineRuntime(): EngineRuntime {
  return { lastBarTime: new Map() };
}

const fmtPrice = (n: number): string => {
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n.toFixed(dp)).toString();
};

function transitionEvents(p: Position, t: PositionTransition): NotificationEvent[] {
  const out: NotificationEvent[] = [];
  for (const e of t.events) {
    const base = {
      strategyId: p.strategyId,
      symbol: p.symbol,
      side: p.side,
      positionId: t.position.id,
    };
    if (e.kind === "filled") {
      telemetry.fill();
      out.push({
        ...base,
        kind: "fill",
        headline: `${p.side} ${p.symbol} filled @ ${fmtPrice(e.price)}`,
        reasons: [],
        fields: [["Stop", fmtPrice(t.position.stopPrice)]],
      });
    } else if (e.kind === "stop_moved") {
      telemetry.stopMove();
      out.push({
        ...base,
        kind: "stop_moved",
        headline: `${p.symbol} stop → ${fmtPrice(e.to)}`,
        reasons: [e.reason],
        fields: [["From", fmtPrice(e.from)], ["To", fmtPrice(e.to)]],
      });
    } else if (e.kind === "closed") {
      telemetry.exit(e.status);
      const pnlR =
        t.position.filledAt != null && Math.abs(t.position.entryPrice - p.stopPrice) > 0
          ? ((e.price - t.position.entryPrice) / Math.abs(t.position.entryPrice - p.stopPrice)) *
            (p.side === "LONG" ? 1 : -1)
          : null;
      out.push({
        ...base,
        kind: "exit",
        headline: `${p.side} ${p.symbol} closed — ${e.status} @ ${fmtPrice(e.price)}`,
        reasons: [e.reason],
        fields: pnlR != null ? [["Result", `${pnlR >= 0 ? "+" : ""}${pnlR.toFixed(2)}R`]] : [],
      });
    }
    // target_changed is logged but not pushed to chat — low-signal noise.
  }
  return out;
}

async function buildContext(
  symbol: string,
  deps: EngineCycleDeps,
  depth: number,
  nowSec: number,
): Promise<StrategyContext | null> {
  const candles15m = await deps.data.getCandles(symbol, "15m", depth);
  if (candles15m.length < 60) return null;
  const last = candles15m[candles15m.length - 1]!;
  // Stale-data guard: refuse to decide on a series whose newest closed bar is
  // older than two intervals (feed outage, backfill lag).
  if (last.time + 2 * BAR_SEC < nowSec - BAR_SEC) {
    logger.warn(`[engine] ${symbol}: candle data stale (last close ${new Date((last.time + BAR_SEC) * 1000).toISOString()}) — skipping`);
    return null;
  }
  const candles1h = await deps.data.getCandles(symbol, "1h", 200);

  // Shared market classification — strategies may use or ignore (H18 computes
  // its own research-parity inputs from the raw 15m series).
  const fullAtr = atrSeries(candles15m, deps.rules.regime.atr_period);
  const regime = classifyRegime(
    candles15m.slice(-320),
    deps.rules.regime,
    fullAtr.slice(-2880).filter(Number.isFinite),
  );
  const closes1h = candles1h.map((c) => c.close);
  const trend = candles1h.length >= 60
    ? emaAdxTrendClassifier(candles1h, ema(closes1h, deps.rules.regime.ema_fast), ema(closes1h, deps.rules.regime.ema_slow))
    : null;

  return {
    symbol,
    closeTime: last.time + BAR_SEC,
    price: last.close,
    candles15m,
    candles1h,
    regime: regime.regime,
    trend: trend?.trend ?? null,
    atr15: fullAtr[fullAtr.length - 1] ?? null,
    atr1h: candles1h.length ? atr(candles1h, deps.rules.regime.atr_period) : null,
    fundingRate: null,
    openInterest: null,
    extras: {},
  };
}

export async function runEngineCycle(deps: EngineCycleDeps, runtime: EngineRuntime): Promise<void> {
  const started = performance.now();
  const strategies = deps.registry.all();
  const depth = Math.max(60, ...strategies.map((s) => s.minBars)) + CONTEXT_HEADROOM;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const symbol of deps.symbols) {
    try {
      await runSymbol(symbol, deps, runtime, depth, nowSec);
    } catch (err) {
      telemetry.error();
      logger.error(`[engine] ${symbol} cycle failed: ${(err as Error).message}`);
    }
  }
  telemetry.cycleDone(performance.now() - started);
}

async function runSymbol(
  symbol: string,
  deps: EngineCycleDeps,
  runtime: EngineRuntime,
  depth: number,
  nowSec: number,
): Promise<void> {
  const strategies = deps.registry.all();
  const open = await deps.store.listOpen({ symbol });
  if (strategies.length === 0 && open.length === 0) return;

  const sctx = await buildContext(symbol, deps, depth, nowSec);
  if (!sctx) return;

  const decisionBar = sctx.candles15m[sctx.candles15m.length - 1]!;
  const lastProcessed = runtime.lastBarTime.get(symbol) ?? 0;

  if (decisionBar.time <= lastProcessed) {
    // Between bars: standing stop/target safety only — no strategy code.
    for (const p of open) {
      const t = evaluateTick(p, sctx.price, Date.now());
      if (t.events.length) {
        await deps.store.update(t.position);
        for (const e of transitionEvents(p, t)) await deps.notifications.publish(e);
      }
    }
    return;
  }
  runtime.lastBarTime.set(symbol, decisionBar.time);
  telemetry.barProcessed(symbol, decisionBar.time);

  // ── Open positions: standing exits → strategy state → strategy exit ───────
  for (let p of open) {
    const standing = evaluateBar(p, decisionBar, sctx.closeTime * 1000);
    if (standing.position !== p) {
      await deps.store.update(standing.position);
      for (const e of transitionEvents(p, standing)) await deps.notifications.publish(e);
    }
    p = standing.position;
    if (p.status !== "OPEN") continue;

    const strategy = deps.registry.get(p.strategyId);
    if (!strategy) {
      // Orphaned position (strategy unregistered): standing exits still protect it.
      logger.warn(`[engine] no strategy registered for open position ${p.id} (${p.strategyId})`);
      continue;
    }

    const nextState = strategy.updateState(sctx, p);
    if (nextState !== p.state) p = { ...p, state: nextState };

    const applied = applyExitDecision(p, strategy.evaluateExit(sctx, p), sctx.price, sctx.closeTime * 1000);
    await deps.store.update(applied.position);
    for (const e of transitionEvents(p, applied)) await deps.notifications.publish(e);
  }

  // ── Free slots: entries ────────────────────────────────────────────────────
  for (const strategy of strategies) {
    if (await deps.store.getOpenBySlot(symbol, strategy.id)) continue;
    const decision = strategy.evaluateEntry(sctx);
    if (!decision.enter) continue;
    telemetry.signal();

    const allOpen = await deps.store.listOpen();
    const account: AccountState = {
      equity: deps.equity,
      openPositions: allOpen.length,
      openRiskFraction:
        deps.equity > 0 ? allOpen.reduce((a, p) => a + p.riskAmount, 0) / deps.equity : 0,
    };
    const sized = deps.risk.size(decision.intent, account);
    if (!sized.approved) {
      telemetry.veto();
      logger.info(`[engine] ${strategy.id} ${symbol} entry vetoed by risk: ${sized.reasons.join("; ")}`);
      continue;
    }

    let position = createPosition(decision.intent, sized, sctx.closeTime * 1000, "pending");
    position = await deps.store.insert(position);
    telemetry.opened();
    logger.info(`[engine] ${strategy.id} ${symbol} ${position.side} entry intent #${position.id}`);
    await deps.notifications.publish({
      kind: "entry",
      strategyId: strategy.id,
      symbol,
      side: position.side,
      positionId: position.id,
      headline: `${position.side} ${symbol}`,
      reasons: decision.intent.reasons,
      fields: [
        ["Entry", `${fmtPrice(position.entryZone.low)} – ${fmtPrice(position.entryZone.high)}`],
        ["Stop", fmtPrice(position.stopPrice)],
        ["Target", position.targetPrice != null ? fmtPrice(position.targetPrice) : "trailing"],
        ...(sized.qty > 0
          ? ([["Size", `${sized.qty.toFixed(4)} (risk ${sized.riskAmount.toFixed(2)})`]] as Array<[string, string]>)
          : []),
      ],
    });
  }
}
