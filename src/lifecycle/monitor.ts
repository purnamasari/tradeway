// Edge lifecycle monitor — runs every 60s, independent of the price-based outcome
// tracker. For each open signal it recomputes the edge from current data, persists
// live values + state, appends a (write-gated) evolution row, and sends a Telegram
// update when the edge meaningfully changes. It never closes a trade — price exits
// stay owned by src/outcome/outcome-tracker.ts.
import type { Db } from "../db/index.js";
import type { Cache } from "../cache.js";
import type { Env, Rules } from "../config.js";
import type { Notifier } from "../notify.js";
import type { MarketContext, StrategyKind, Direction, SignalUpdate } from "../types.js";
import {
  fetchOpenOutcomes,
  hydrateContextHistory,
  updateLiveEdge,
  recordEdgeUpdate,
  type OutcomeRow,
  type LiveEdgeUpdate,
} from "../db/accumulate.js";
import { computeEdgeSnapshot, classifyEdgeState, type EdgeOriginal } from "./edge.js";
import { logger } from "../logger.js";

export interface EdgeMonitorDeps {
  db: Db;
  getContext: (symbol: string, category: string) => Promise<MarketContext>;
  category: string;
  cache: Cache;
  rules: Rules;
  env: Env;
  notifier: Notifier;
}

export async function monitorEdges(deps: EdgeMonitorDeps): Promise<void> {
  const { db, getContext, category, rules } = deps;
  if (!db) return;

  const outcomes = await fetchOpenOutcomes(db);
  if (outcomes.length === 0) return;

  // One context build per unique symbol (max one open outcome per symbol anyway).
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
      logger.warn(`[edge] context build failed for ${symbol}: ${(err as Error).message}`);
      continue;
    }
    if (ctx.candles15m.length < 60 || ctx.candles4h.length < 60) {
      logger.warn(`[edge] ${symbol}: insufficient candle history, skipping`);
      continue;
    }

    for (const o of rows) {
      try {
        await evaluateOutcomeEdge(o, ctx, deps);
      } catch (err) {
        logger.error(`[edge] eval failed for #${o.id} ${symbol}: ${(err as Error).message}`);
      }
    }
  }
}

async function evaluateOutcomeEdge(
  o: OutcomeRow,
  ctx: MarketContext,
  deps: EdgeMonitorDeps,
): Promise<void> {
  const { db, rules, env, cache, notifier } = deps;
  const lc = rules.lifecycle;

  // Rows created before the edge lifecycle existed have no baseline — skip them.
  if (o.original_confidence == null) {
    logger.debug?.(`[edge] #${o.id} ${o.symbol}: no original baseline, skipping`);
    return;
  }

  const strategy = o.strategy as StrategyKind;
  const direction = o.direction as Direction;

  const live = await computeEdgeSnapshot(ctx, strategy, direction, rules, cache, env);
  const original: EdgeOriginal = {
    confidence: o.original_confidence,
    funding_percentile: o.original_factors?.funding_percentile ?? 50,
    oi_zscore: o.original_factors?.oi_zscore ?? 0,
  };
  const { state, reasons } = classifyEdgeState(original, live, lc);

  const now = new Date();
  const stateChanged = state !== o.edge_state;

  // ── History write gate (bound row growth) ────────────────────────────────────
  const lastRecConf = o.last_recorded_confidence;
  const recordDue =
    o.last_edge_record_at == null ||
    stateChanged ||
    (lastRecConf != null && Math.abs(live.confidence - lastRecConf) >= lc.edge_history_min_delta) ||
    now.getTime() - new Date(o.last_edge_record_at).getTime() >= lc.edge_history_min_interval_min * 60_000;

  // ── Notify gate ──────────────────────────────────────────────────────────────
  const baseConf = o.last_notified_confidence ?? o.original_confidence;
  const confMoved = Math.abs(live.confidence - baseConf) >= lc.update_confidence_delta;
  const intervalOk =
    o.last_update_sent_at == null ||
    now.getTime() - new Date(o.last_update_sent_at).getTime() >= lc.update_min_interval_min * 60_000;
  const wasInvalidated = o.edge_state === "INVALIDATED";
  // State changes always notify; otherwise a significant confidence move (but not
  // once already INVALIDATED — stay quiet until it changes state again).
  const shouldNotify = stateChanged || (!wasInvalidated && confMoved && intervalOk);

  // ── Persist live edge (+ conditional bookkeeping) ────────────────────────────
  const fields: LiveEdgeUpdate = {
    live_confidence: live.confidence,
    live_setup_quality: live.setup_quality,
    edge_state: state,
    live_factors: {
      funding_percentile: live.funding_percentile,
      oi_zscore: live.oi_zscore,
      volume_percentile: live.volume_percentile,
      structure_intact: live.structure_intact,
      trend: live.trend,
    },
    updated_at: now,
  };
  if (recordDue) {
    fields.last_edge_record_at = now;
    fields.last_recorded_confidence = live.confidence;
  }
  if (shouldNotify) {
    fields.last_update_sent_at = now;
    fields.last_notified_confidence = live.confidence;
  }
  await updateLiveEdge(db, o.id, fields);

  if (recordDue) {
    await recordEdgeUpdate(db, {
      outcome_id: o.id,
      signal_id: o.signal_id,
      symbol: o.symbol,
      edge_state: state,
      live_confidence: live.confidence,
      live_setup_quality: live.setup_quality,
      funding_percentile: live.funding_percentile,
      oi_zscore: live.oi_zscore,
      volume_percentile: live.volume_percentile,
      structure_intact: live.structure_intact,
      trend: live.trend,
      trend_aligned: live.trend_aligned,
      regime_aligned: live.regime_aligned,
    });
  }

  if (stateChanged || shouldNotify) {
    logger.info(
      `[edge] #${o.id} ${o.symbol} ${direction} ${strategy} ${o.edge_state}→${state} ` +
        `conf ${o.original_confidence}→${live.confidence}` +
        (reasons.length ? ` (${reasons.join("; ")})` : ""),
    );
  }

  if (shouldNotify) {
    const update: SignalUpdate = {
      symbol: o.symbol,
      direction,
      strategy,
      edgeState: state,
      original: {
        confidence: original.confidence,
        funding_percentile: original.funding_percentile,
        oi_zscore: original.oi_zscore,
      },
      live: {
        confidence: live.confidence,
        funding_percentile: live.funding_percentile,
        oi_zscore: live.oi_zscore,
      },
      reasons,
    };
    try {
      await notifier.sendSignalUpdate(update);
    } catch (err) {
      logger.warn(`[edge] update notification failed for #${o.id}: ${(err as Error).message}`);
    }
  }
}
