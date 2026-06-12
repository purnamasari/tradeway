// Trade manager — runs every 60s, the active-trade counterpart of the scanner.
// For every FILLED trade (status ACTIVE, signal-sourced or autodetected Bybit
// position) it re-reads the market, assesses health/rejection/decay/liquidity,
// suggests management actions, and alerts — with conservative throttling so a
// persisting condition pages once, not every minute.
//
// Division of labour (all three run on the same 60s cadence):
//   outcome-tracker  — owns price exits (TP/SL/expiry). Untouched.
//   edge monitor     — owns the signal's thesis (live confidence). The manager
//                      consumes its live_confidence as "current confidence".
//   trade manager    — owns in-trade decisions: stops, partials, exit warnings.
//
// Messaging: signal trades get their tracked message edited in place with the
// full trade report (quiet updates); event alerts go out as new messages, gated
// by per-kind latches + cooldowns. Bybit rows keep their reconciler-owned live
// message (which renders the persisted health fields) — the manager only sends
// event alerts for them.
import type { Db } from "../db/index.js";
import type { Notifier } from "../notify.js";
import { formatManagementEvent, formatTradeReport } from "../notify.js";
import type { Direction, ManagementEvent, ManagementState, MarketContext } from "../types.js";
import type { Rules } from "../config.js";
import {
  fetchOpenOutcomes,
  hydrateContextHistory,
  updateManagement,
  recordManagementEvent,
  type OutcomeRow,
  type ManagementMeta,
} from "../db/accumulate.js";
import { assessTrade, type ManagedTrade } from "./assess.js";
import { logger } from "../logger.js";

export interface TradeManagerDeps {
  db: Db;
  getContext: (symbol: string, category: string) => Promise<MarketContext>;
  category: string;
  rules: Rules;
  notifier: Notifier;
}

export async function manageTrades(deps: TradeManagerDeps): Promise<void> {
  const { db, getContext, category, rules } = deps;
  if (!db || !rules.management.enabled) return;

  // Management starts at the fill: PENDING_ENTRY rows have no position to manage
  // (their plan was delivered with the alert), shadows are counterfactual-only.
  // Engine positions (source='engine') are excluded: the strategy engine owns
  // their stops/exits and messaging — double-managing would double-message.
  const outcomes = (await fetchOpenOutcomes(db, { followedOnly: true })).filter(
    (o) => o.status === "ACTIVE" && o.source !== "engine",
  );
  if (outcomes.length === 0) return;

  const bySymbol = new Map<string, OutcomeRow[]>();
  for (const o of outcomes) {
    const list = bySymbol.get(o.symbol);
    if (list) list.push(o);
    else bySymbol.set(o.symbol, [o]);
  }

  for (const [symbol, rows] of bySymbol) {
    let ctx: MarketContext;
    try {
      ctx = await getContext(symbol, category);
      await hydrateContextHistory(db, ctx, rules);
    } catch (err) {
      logger.warn(`[manage] context build failed for ${symbol}: ${(err as Error).message}`);
      continue;
    }
    if (ctx.candles15m.length < 60 || ctx.candles1m.length < 30) {
      logger.warn(`[manage] ${symbol}: insufficient candle history, skipping`);
      continue;
    }

    for (const o of rows) {
      try {
        await manageOutcome(o, ctx, deps);
      } catch (err) {
        logger.error(`[manage] failed for #${o.id} ${symbol}: ${(err as Error).message}`);
      }
    }
  }
}

async function manageOutcome(
  o: OutcomeRow,
  ctx: MarketContext,
  deps: TradeManagerDeps,
): Promise<void> {
  const { db, rules, notifier } = deps;
  const m = rules.management;
  const meta: ManagementMeta = { ...(o.management_meta ?? {}) };
  const now = Date.now();

  // Initial risk is captured once: Bybit stops can move later, and R-multiples
  // must stay anchored to the risk taken at entry.
  if (meta.initial_risk === undefined) {
    meta.initial_risk = o.sl > 0 ? Math.abs(o.entry_price - o.sl) : null;
  }

  const trade: ManagedTrade = {
    symbol: o.symbol,
    direction: o.direction as Direction,
    strategy: o.strategy,
    source: o.source,
    entryPrice: o.entry_price,
    sl: o.sl > 0 ? o.sl : null,
    tp: o.tp > 0 ? o.tp : null,
    initialRisk: meta.initial_risk,
    entryConfidence: o.original_confidence,
    currentConfidence: o.live_confidence,
    edgeState: o.edge_state,
  };

  const a = assessTrade(trade, ctx, rules);
  const events: ManagementEvent[] = [...a.events];

  // ── Health-drop event (stateful — needs the previous alerted health) ────────
  const lastAlertHealth = meta.last_alert_health;
  if (lastAlertHealth != null && lastAlertHealth - a.health.total >= m.health_alert_drop) {
    events.push({
      kind: "health_drop",
      severity: a.health.band === "exit_candidate" || a.health.band === "weak" ? "warning" : "info",
      title: "Trade health declining",
      happened: [
        `Trade health ${lastAlertHealth} → ${a.health.total} (${a.health.band.replace("_", " ")})`,
        ...a.warnings.slice(0, 3),
      ],
      matters: "Several components of this trade are deteriorating together — drift like this usually precedes a deeper retrace.",
      actions: a.actions.length > 0 ? a.actions.slice(0, 2) : ["Tighten stop", "Reduce exposure"],
    });
  }

  // ── Profit-locking stop event (the Smart Stop Management moment) ────────────
  const sign = trade.direction === "long" ? 1 : -1;
  const stopLocksProfit = a.stop != null && sign * (a.stop.price - trade.entryPrice) >= 0;
  if (a.stop && stopLocksProfit && !meta.stop_locked) {
    events.push({
      kind: "stop_suggestion",
      severity: "info",
      title: "Stop can now protect profit",
      happened: [
        `Current stop: ${trade.sl ?? "none"}`,
        `Suggested stop: ${a.stop.price} (${a.stop.method} trail)`,
        ...a.stop.reasons,
      ],
      matters: "Moving the stop here makes the trade risk-free while keeping the target open.",
      actions: [`Move SL to ${a.stop.price}`],
    });
  }

  // ── Notification policy: latch + cooldown ───────────────────────────────────
  // A condition alerts when it first appears (not present last pass) and its
  // kind's cooldown has elapsed. While it persists, the latch keeps it silent.
  const latched = new Set(meta.latched ?? []);
  const alerted = { ...(meta.alerted ?? {}) };
  const cooldownMs = m.event_cooldown_min * 60_000;
  const toNotify = events.filter((e) => {
    if (e.kind === "health_snapshot") return false;
    if (latched.has(e.kind)) return false;
    const last = alerted[e.kind] ?? 0;
    // Criticals re-arm faster: a re-entering emergency shouldn't wait out the
    // full warning cooldown.
    const required = e.severity === "critical" ? Math.min(cooldownMs, 15 * 60_000) : cooldownMs;
    return now - last >= required;
  });

  for (const event of toNotify) {
    try {
      await notifier.sendManagement(formatManagementEvent(o.symbol, trade.direction, event, a), {
        outcomeId: o.id,
      });
      alerted[event.kind] = now;
    } catch (err) {
      logger.warn(`[manage] alert failed for #${o.id} ${event.kind}: ${(err as Error).message}`);
    }
    await recordManagementEvent(db, {
      outcome_id: o.id,
      symbol: o.symbol,
      kind: event.kind,
      severity: event.severity,
      trade_health: a.health.total,
      current_confidence: a.currentConfidence,
      price: a.price,
      pnl_pct: a.pnlPct,
      suggested_stop: a.stop?.price ?? null,
      details: { happened: event.happened, actions: event.actions, components: a.health.components },
    });
  }

  // ── Routine in-place report (signal trades own their tracked message) ───────
  const bandChanged = meta.last_band !== undefined && meta.last_band !== a.health.band;
  const reportDue =
    meta.last_report_at == null ||
    bandChanged ||
    toNotify.length > 0 ||
    now - meta.last_report_at >= m.update_min_interval_min * 60_000;
  if (o.source !== "bybit" && o.notify_message_id != null && reportDue) {
    try {
      await notifier.editMessage(o.notify_message_id, o.notify_is_photo, formatTradeReport(o, a));
      meta.last_report_at = now;
    } catch (err) {
      logger.warn(`[manage] report edit failed for #${o.id}: ${(err as Error).message}`);
    }
  }

  // ── Throttled health history heartbeat ──────────────────────────────────────
  const historyDue =
    meta.last_history_at == null ||
    now - meta.last_history_at >= m.history_min_interval_min * 60_000 ||
    (meta.last_history_health != null &&
      Math.abs(a.health.total - meta.last_history_health) >= m.history_min_health_delta);
  if (historyDue) {
    await recordManagementEvent(db, {
      outcome_id: o.id,
      symbol: o.symbol,
      kind: "health_snapshot",
      severity: "info",
      trade_health: a.health.total,
      current_confidence: a.currentConfidence,
      price: a.price,
      pnl_pct: a.pnlPct,
      suggested_stop: a.stop?.price ?? null,
      details: { components: a.health.components, paths: a.paths },
    });
    meta.last_history_at = now;
    meta.last_history_health = a.health.total;
  }

  // ── Persist the latest assessment onto the row ──────────────────────────────
  // MANAGED is sticky: once an action has been suggested the trade stays managed.
  const state: ManagementState =
    o.management_state === "MANAGED" || a.actions.length > 0 || toNotify.length > 0
      ? "MANAGED"
      : "MONITORING";

  meta.latched = events.map((e) => e.kind).filter((k) => k !== "health_snapshot");
  meta.alerted = alerted;
  if (toNotify.length > 0 || meta.last_alert_health == null) {
    meta.last_alert_health = a.health.total;
  }
  meta.last_band = a.health.band;
  if (stopLocksProfit && toNotify.some((e) => e.kind === "stop_suggestion")) {
    meta.stop_locked = true;
  }

  await updateManagement(db, o.id, {
    management_state: state,
    trade_health: a.health.total,
    health_components: a.health.components,
    suggested_stop: a.stop?.price ?? null,
    suggested_stop_method: a.stop?.method ?? null,
    path_probs: a.paths,
    management_snapshot: {
      observations: a.observations,
      warnings: a.warnings,
      actions: a.actions,
      emergency: a.emergency,
      pnl_pct: a.pnlPct,
      pnl_r: a.pnlR,
      price: a.price,
      updated_at: new Date(now).toISOString(),
    },
    management_meta: meta,
  });

  if (toNotify.length > 0 || bandChanged) {
    logger.info(
      `[manage] #${o.id} ${o.symbol} ${trade.direction} health ${a.health.total} (${a.health.band})` +
        ` pnl ${a.pnlPct}%` +
        (toNotify.length ? ` · alerts: ${toNotify.map((e) => e.kind).join(", ")}` : ""),
    );
  }
}
