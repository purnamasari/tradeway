// Metric history accumulation. Records per-scan data into Postgres for
// building percentile/z-score windows over time.
// Also handles signal outcome persistence.
import type { Db } from "./index.js";
import type {
  Candle,
  MarketContext,
  RegimeResult,
  TrendResult,
  Signal,
  StrategyKind,
  EdgeState,
  Direction,
  ManagementState,
  ManagementPlan,
  ManagementSeverity,
  PathProbabilities,
  HealthComponents,
  StopMethod,
} from "../types.js";
import type { Rules } from "../config.js";
import { ENTRY_TTL } from "../types.js";
import { metricHistory, marketHistory, signals as signalsTable, regimeLog, signalOutcomes, signalEdgeUpdates, tradeManagementEvents } from "./schema.js";
import { atr, adx, ema, atrSeries } from "../indicators.js";
import { logger } from "../logger.js";
import { asc, desc, eq, gte, lt, and, sql, inArray, isNotNull, isNull } from "drizzle-orm";

/**
 * Merge backfilled market_history + accumulated metric_history into `ctx`'s
 * percentile/z-score windows and historyConfidence. Mutates `ctx` in place.
 * Shared by the scanner and the edge monitor so both score against identical
 * historical context. No-op when db is null.
 */
export async function hydrateContextHistory(
  db: Db,
  ctx: MarketContext,
  rules: Rules,
): Promise<void> {
  if (!db) return;
  const marketHist = await fetchHistoricalContextFromMarketHistory(db, ctx.symbol, {
    fundingDays: rules.backfill.funding_days,
    oiDays: rules.backfill.oi_days,
    candleDays: rules.backfill.percentile_days,
    atrPeriod: rules.regime.atr_period,
  });
  const metricHist = await fetchHistoricalMetricsFromDb(db, ctx.symbol);

  const fundingHistory = [...(marketHist?.fundingHistory ?? []), ...(metricHist?.fundingHistory ?? [])];
  const oiHistory = [...(marketHist?.oiHistory ?? []), ...(metricHist?.oiHistory ?? [])];
  const atrHistory = [...(marketHist?.atrHistory ?? []), ...(metricHist?.atrHistory ?? [])];
  const volumeHistory = [...(marketHist?.volumeHistory ?? []), ...(metricHist?.volumeHistory ?? [])];
  const recordCount = (marketHist?.recordCount ?? 0) + (metricHist?.recordCount ?? 0);

  ctx.historyConfidence = Math.min(recordCount / 100, 1.0);
  if (oiHistory.length >= 30) ctx.oiHistory = oiHistory;
  if (fundingHistory.length >= 50) ctx.fundingHistory = fundingHistory;
  if (atrHistory.length >= 50) ctx.atrHistory = atrHistory;
  if (volumeHistory.length >= 50) ctx.volumeHistory = volumeHistory;
}


/**
 * Record market metrics for a single scan. One row per symbol per scan.
 * Called immediately after regime + trend classification so we capture data
 * even when no signal fires.
 */
export async function recordMetrics(
  db: Db,
  ctx: MarketContext,
  regime: RegimeResult,
): Promise<void> {
  if (!db) return;
  try {
    const closes15m = ctx.candles15m.map((c) => c.close);
    const closes1h = ctx.candles1h.map((c) => c.close);
    const lastCandle = ctx.candles15m.at(-1);

    await db.insert(metricHistory).values({
      symbol: ctx.symbol,
      funding_rate: ctx.fundingRate,
      open_interest: ctx.openInterest,
      atr: atr(ctx.candles15m, 14),
      adx: adx(ctx.candles15m, 14),
      volume_15m: lastCandle?.volume ?? null,
      ema20: ema(closes1h, 20),
      ema50: ema(closes1h, 50),
      price: lastCandle?.close ?? 0,
    });
  } catch (err) {
    logger.warn(`[db] recordMetrics failed for ${ctx.symbol}: ${(err as Error).message}`);
  }
}

/** Record regime classification for backtesting. */
export async function recordRegime(
  db: Db,
  symbol: string,
  regime: RegimeResult,
): Promise<void> {
  if (!db) return;
  try {
    await db.insert(regimeLog).values({
      symbol,
      regime: regime.regime,
      adx: regime.adx,
      atr_percentile: regime.atrPercentile,
      ema_spread_pct: regime.emaSpreadPct,
    });
  } catch (err) {
    logger.warn(`[db] recordRegime failed for ${symbol}: ${(err as Error).message}`);
  }
}

/** Record a signal that passed all gates. Returns the inserted row ID (or null if no DB). */
export async function recordSignal(db: Db, signal: Signal): Promise<number | null> {
  if (!db) return null;
  try {
    const rows = await db.insert(signalsTable).values({
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      confidence: signal.confidence,
      setup_quality: signal.setup_quality,
      rr: signal.rr,
      regime: signal.regime,
      trend: signal.trend,
      trend_source: signal.trend_source,
      payload: signal,
      detected_at: new Date(signal.detected_at),
    }).returning({ id: signalsTable.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.warn(`[db] recordSignal failed for ${signal.symbol}: ${(err as Error).message}`);
    return null;
  }
}

/** Reconstruct a Signal from its stored payload (for Follow/Skip actions). */
export async function fetchSignalById(db: Db, id: number): Promise<Signal | null> {
  if (!db) return null;
  try {
    const rows = await db
      .select({ payload: signalsTable.payload })
      .from(signalsTable)
      .where(eq(signalsTable.id, id))
      .limit(1);
    return (rows[0]?.payload as Signal) ?? null;
  } catch (err) {
    logger.warn(`[db] fetchSignalById failed for #${id}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Record the human Follow/Skip decision on a signal. Idempotent: only the first
 * decision sticks (WHERE decision IS NULL), so a double-press is a no-op. Returns
 * true if this call set the decision, false if it was already decided.
 */
export async function setSignalDecision(
  db: Db,
  id: number,
  decision: "followed" | "skipped",
): Promise<boolean> {
  if (!db) return false;
  try {
    const rows = await db
      .update(signalsTable)
      .set({ decision, decided_at: new Date() })
      .where(and(eq(signalsTable.id, id), isNull(signalsTable.decision)))
      .returning({ id: signalsTable.id });
    return rows.length > 0;
  } catch (err) {
    logger.warn(`[db] setSignalDecision failed for #${id}: ${(err as Error).message}`);
    return false;
  }
}

/** Persist the Telegram alert message ref on a signal, so its tracked outcome can
 *  edit that message in place on edge updates (anti-spam). No-op if no message id. */
export async function setSignalAlertRef(
  db: Db,
  signalId: number,
  ref: NotifyRef,
): Promise<void> {
  if (!db || ref.messageId == null) return;
  try {
    await db
      .update(signalsTable)
      .set({ alert_message_id: ref.messageId, alert_is_photo: ref.isPhoto })
      .where(eq(signalsTable.id, signalId));
  } catch (err) {
    logger.warn(`[db] setSignalAlertRef failed for #${signalId}: ${(err as Error).message}`);
  }
}

/** Read back a signal's stored alert message ref (for the Follow path). */
export async function fetchSignalAlertRef(db: Db, signalId: number): Promise<NotifyRef> {
  if (!db) return { messageId: null, isPhoto: false };
  try {
    const rows = await db
      .select({ id: signalsTable.alert_message_id, photo: signalsTable.alert_is_photo })
      .from(signalsTable)
      .where(eq(signalsTable.id, signalId))
      .limit(1);
    return { messageId: rows[0]?.id ?? null, isPhoto: rows[0]?.photo ?? false };
  } catch (err) {
    logger.warn(`[db] fetchSignalAlertRef failed for #${signalId}: ${(err as Error).message}`);
    return { messageId: null, isPhoto: false };
  }
}

/** Set the notify message ref on an outcome (the message edge/PnL updates edit). */
export async function setOutcomeNotifyRef(
  db: Db,
  outcomeId: number,
  ref: NotifyRef,
): Promise<void> {
  if (!db || ref.messageId == null) return;
  try {
    await db
      .update(signalOutcomes)
      .set({ notify_message_id: ref.messageId, notify_is_photo: ref.isPhoto })
      .where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] setOutcomeNotifyRef failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

// ── Outcome persistence ─────────────────────────────────────────────────────

/**
 * Create an outcome row in PENDING_ENTRY status.
 * expires_at is set to now + entry_ttl (time allowed to reach entry zone).
 * `notify` carries the Telegram alert message to edit in place on later updates.
 */
export async function createOutcome(
  db: Db,
  signal: Signal,
  signalId: number,
  followed = true,
  notify: NotifyRef = { messageId: null, isPhoto: false },
): Promise<void> {
  if (!db) return;
  try {
    const now = new Date();
    const entryTtl = ENTRY_TTL[signal.strategy as StrategyKind] ?? 60 * 60 * 1000;
    const expiresAt = new Date(now.getTime() + entryTtl);

    await db.insert(signalOutcomes).values({
      signal_id: signalId,
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      followed,
      status: "PENDING_ENTRY",
      entry_price: (signal.entry_low + signal.entry_high) / 2,
      entry_low: signal.entry_low,
      entry_high: signal.entry_high,
      sl: signal.sl,
      tp: signal.tp,
      opened_at: now,
      expires_at: expiresAt,
      notify_message_id: notify.messageId,
      notify_is_photo: notify.isPhoto,
      // ── Edge lifecycle seed: immutable originals ──────────────────────────
      original_confidence: signal.confidence,
      original_setup_quality: signal.setup_quality,
      edge_state: "ACTIVE",
      original_factors: {
        funding_percentile: signal.score_breakdown.funding_percentile,
        oi_zscore: signal.score_breakdown.oi_zscore,
        volume_percentile: signal.score_breakdown.volume_percentile,
        structure_intact: signal.score_breakdown.structure_intact,
        trend: signal.trend,
        regime: signal.regime,
      },
      // ── Trade management seed: plan + expected paths from detection time ───
      management_plan: signal.plan ?? null,
      path_probs: signal.paths ?? null,
    });
    logger.info(`[outcome] Created PENDING_ENTRY${followed ? "" : " (shadow)"} for ${signal.symbol} ${signal.direction} ${signal.strategy} (signal #${signalId})`);
  } catch (err) {
    logger.warn(`[db] createOutcome failed for ${signal.symbol}: ${(err as Error).message}`);
  }
}

/** Row shape returned from fetchPendingOutcomes. */
export interface OutcomeRow {
  id: number;
  signal_id: number;
  symbol: string;
  strategy: string;
  direction: string;
  status: string;
  entry_price: number;
  entry_low: number;
  entry_high: number;
  sl: number;
  tp: number;
  hit_price: number | null;
  opened_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
  expires_at: Date;
  followed: boolean;
  source: string; // 'signal' | 'bybit'
  // Edge lifecycle
  original_confidence: number | null;
  original_setup_quality: number | null;
  live_confidence: number | null;
  live_setup_quality: number | null;
  edge_state: string;
  original_factors: EdgeFactorsSnapshot | null;
  live_factors: EdgeFactorsSnapshot | null;
  updated_at: Date | null;
  duration_ms: number | null;
  last_update_sent_at: Date | null;
  last_notified_confidence: number | null;
  last_edge_record_at: Date | null;
  last_recorded_confidence: number | null;
  notify_message_id: number | null;
  notify_is_photo: boolean;
  // Trade management
  management_state: string; // ManagementState
  trade_health: number | null;
  health_components: HealthComponents | null;
  suggested_stop: number | null;
  suggested_stop_method: string | null;
  management_plan: ManagementPlan | null;
  path_probs: PathProbabilities | null;
  management_snapshot: ManagementSnapshot | null;
  management_meta: ManagementMeta | null;
}

/** Latest assessment surface persisted for on-demand rendering (/running Details). */
export interface ManagementSnapshot {
  observations: string[];
  warnings: string[];
  actions: string[];
  emergency: string[];
  pnl_pct: number;
  pnl_r: number | null;
  price: number;
  updated_at: string; // ISO
}

/** Manager bookkeeping — cooldowns, latches, and throttle timestamps. */
export interface ManagementMeta {
  /** Initial |entry−SL| captured on first manage pass (Bybit SLs can move later). */
  initial_risk?: number | null;
  /** Last alert timestamp (ms) per event kind, for cooldowns. */
  alerted?: Record<string, number>;
  /** Event kinds present on the previous pass — a persisting condition alerts once. */
  latched?: string[];
  /** True once a profit-locking stop suggestion has been alerted. */
  stop_locked?: boolean;
  /** Health band at the last notified report, for band-change detection. */
  last_band?: string;
  /** Health total at the last alert, for health_alert_drop gating. */
  last_alert_health?: number;
  /** Last in-place report edit (ms). */
  last_report_at?: number;
  /** Last history heartbeat (ms) + health written, for the write gate. */
  last_history_at?: number;
  last_history_health?: number;
}

/** A Telegram message reference to edit in place (anti-spam refresh). */
export interface NotifyRef {
  messageId: number | null;
  isPhoto: boolean;
}

/** Shape of the `original_factors` / `live_factors` JSONB blobs. */
export interface EdgeFactorsSnapshot {
  funding_percentile?: number;
  oi_zscore?: number;
  volume_percentile?: number;
  structure_intact?: boolean;
  trend?: string;
  regime?: string;
  size?: number; // position size, for source='bybit' rows (no signal factors)
}

/**
 * Fetch open outcomes (PENDING_ENTRY or ACTIVE). The price tracker wants all of
 * them (incl. shadows, for counterfactual eval); the edge monitor passes
 * `followedOnly` to skip shadows.
 */
export async function fetchOpenOutcomes(
  db: Db,
  opts: { followedOnly?: boolean } = {},
): Promise<OutcomeRow[]> {
  if (!db) return [];
  try {
    const open = inArray(signalOutcomes.status, ["PENDING_ENTRY", "ACTIVE"]);
    const where = opts.followedOnly ? and(open, eq(signalOutcomes.followed, true)) : open;
    const rows = await db.select().from(signalOutcomes).where(where);
    return rows as OutcomeRow[];
  } catch (err) {
    logger.warn(`[db] fetchOpenOutcomes failed: ${(err as Error).message}`);
    return [];
  }
}

/** Transition a PENDING_ENTRY outcome to ACTIVE. Sets activated_at and new expires_at. */
export async function activateOutcome(
  db: Db,
  outcomeId: number,
  activatedAt: Date,
  newExpiresAt: Date,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .update(signalOutcomes)
      .set({
        status: "ACTIVE",
        activated_at: activatedAt,
        expires_at: newExpiresAt,
      })
      .where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] activateOutcome failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

/**
 * Close an outcome with a terminal status. `openedAt` is used to record
 * `duration_ms` (closed_at − opened_at) for future analytics.
 */
export async function closeOutcome(
  db: Db,
  outcomeId: number,
  status: "TP_HIT" | "SL_HIT" | "EXPIRED" | "CLOSED",
  hitPrice: number | null,
  closedAt: Date,
  openedAt?: Date,
): Promise<void> {
  if (!db) return;
  try {
    const durationMs = openedAt ? closedAt.getTime() - openedAt.getTime() : null;
    await db
      .update(signalOutcomes)
      .set({
        status,
        hit_price: hitPrice,
        closed_at: closedAt,
        duration_ms: durationMs,
      })
      .where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] closeOutcome failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

// ── Edge lifecycle persistence ──────────────────────────────────────────────

/** Fetch the single open (PENDING_ENTRY|ACTIVE) outcome for a symbol, if any. */
export async function fetchOpenOutcomeForSymbol(
  db: Db,
  symbol: string,
): Promise<OutcomeRow | null> {
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(signalOutcomes)
      .where(
        and(
          eq(signalOutcomes.symbol, symbol),
          eq(signalOutcomes.followed, true),
          inArray(signalOutcomes.status, ["PENDING_ENTRY", "ACTIVE"]),
        ),
      )
      .limit(1);
    return (rows[0] as OutcomeRow) ?? null;
  } catch (err) {
    logger.warn(`[db] fetchOpenOutcomeForSymbol failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// ── Bybit (autodetected real position) outcomes ──────────────────────────────

export interface BybitOutcomeInput {
  symbol: string;
  direction: Direction;
  entryPrice: number;
  size: number; // contracts/qty held — informational, shown in /running
  sl: number | null; // Bybit's set SL, if any (0 when unset)
  tp: number | null; // Bybit's set TP, if any (0 when unset)
}

// Real positions have no signal-defined entry window or TTL — they exit when the user
// closes them (reconciler detects the disappearance). expires_at must be non-null, so
// set it far out; the price tracker skips source='bybit' rows anyway.
const BYBIT_OUTCOME_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Create an ACTIVE, source='bybit' outcome for an autodetected real position. signal_id
 * is a 0 sentinel (there is no originating signal; no FK exists), strategy is 'manual'.
 * These are tracked for PnL and shown in /running but NOT edge-monitored — edge health
 * validates a *signal's* thesis, which a manual trade does not have. Returns the new id.
 */
export async function createBybitOutcome(
  db: Db,
  input: BybitOutcomeInput,
): Promise<number | null> {
  if (!db) return null;
  try {
    const now = new Date();
    const rows = await db
      .insert(signalOutcomes)
      .values({
        signal_id: 0,
        symbol: input.symbol,
        strategy: "manual",
        direction: input.direction,
        source: "bybit",
        followed: true,
        status: "ACTIVE",
        entry_price: input.entryPrice,
        entry_low: input.entryPrice,
        entry_high: input.entryPrice,
        sl: input.sl ?? 0,
        tp: input.tp ?? 0,
        opened_at: now,
        activated_at: now,
        expires_at: new Date(now.getTime() + BYBIT_OUTCOME_TTL_MS),
        // Stash size in original_factors so /running can show it without a new column.
        original_factors: { size: input.size } as EdgeFactorsSnapshot,
      })
      .returning({ id: signalOutcomes.id });
    const id = rows[0]?.id ?? null;
    logger.info(
      `[position] Tracking real ${input.symbol} ${input.direction} @ ${input.entryPrice} (outcome #${id})`,
    );
    return id;
  } catch (err) {
    logger.warn(`[db] createBybitOutcome failed for ${input.symbol}: ${(err as Error).message}`);
    return null;
  }
}

/** Open (PENDING_ENTRY|ACTIVE) outcomes that came from a real Bybit position. */
export async function fetchOpenBybitOutcomes(db: Db): Promise<OutcomeRow[]> {
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(signalOutcomes)
      .where(
        and(
          eq(signalOutcomes.source, "bybit"),
          inArray(signalOutcomes.status, ["PENDING_ENTRY", "ACTIVE"]),
        ),
      );
    return rows as OutcomeRow[];
  } catch (err) {
    logger.warn(`[db] fetchOpenBybitOutcomes failed: ${(err as Error).message}`);
    return [];
  }
}

/** Most recently closed followed trades (for the /recent evaluation view). */
export async function fetchRecentClosedOutcomes(db: Db, limit = 10): Promise<OutcomeRow[]> {
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(signalOutcomes)
      .where(
        and(
          eq(signalOutcomes.followed, true),
          inArray(signalOutcomes.status, ["TP_HIT", "SL_HIT", "EXPIRED", "CLOSED"]),
        ),
      )
      .orderBy(desc(signalOutcomes.closed_at))
      .limit(Math.max(1, Math.min(limit, 50)));
    return rows as OutcomeRow[];
  } catch (err) {
    logger.warn(`[db] fetchRecentClosedOutcomes failed: ${(err as Error).message}`);
    return [];
  }
}

/** Fetch a single outcome row by id (for the /running Details button). */
export async function fetchOutcomeById(db: Db, id: number): Promise<OutcomeRow | null> {
  if (!db) return null;
  try {
    const rows = await db.select().from(signalOutcomes).where(eq(signalOutcomes.id, id)).limit(1);
    return (rows[0] as OutcomeRow) ?? null;
  } catch (err) {
    logger.warn(`[db] fetchOutcomeById failed for #${id}: ${(err as Error).message}`);
    return null;
  }
}

export interface LiveEdgeUpdate {
  live_confidence: number;
  live_setup_quality: number;
  edge_state: EdgeState;
  live_factors: EdgeFactorsSnapshot;
  updated_at: Date;
  // Optional throttle/bookkeeping fields — only set when the monitor acted.
  last_update_sent_at?: Date;
  last_notified_confidence?: number;
  last_edge_record_at?: Date;
  last_recorded_confidence?: number;
}

/** Persist the latest live edge values onto the outcome row. */
export async function updateLiveEdge(
  db: Db,
  outcomeId: number,
  fields: LiveEdgeUpdate,
): Promise<void> {
  if (!db) return;
  try {
    await db.update(signalOutcomes).set(fields).where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] updateLiveEdge failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

export interface EdgeUpdateRow {
  outcome_id: number;
  signal_id: number;
  symbol: string;
  edge_state: EdgeState;
  live_confidence: number;
  live_setup_quality: number;
  funding_percentile: number | null;
  oi_zscore: number | null;
  volume_percentile: number | null;
  structure_intact: boolean;
  trend: string;
  trend_aligned: boolean;
  regime_aligned: boolean;
}

/** Append one edge-evolution row (gated by the monitor to bound row growth). */
export async function recordEdgeUpdate(db: Db, row: EdgeUpdateRow): Promise<void> {
  if (!db) return;
  try {
    await db.insert(signalEdgeUpdates).values(row);
  } catch (err) {
    logger.warn(`[db] recordEdgeUpdate failed for outcome #${row.outcome_id}: ${(err as Error).message}`);
  }
}

// ── Trade management persistence ──────────────────────────────────────────────

export interface ManagementUpdate {
  management_state: ManagementState;
  trade_health: number;
  health_components: HealthComponents;
  suggested_stop: number | null;
  suggested_stop_method: StopMethod | null;
  path_probs: PathProbabilities | null;
  management_snapshot: ManagementSnapshot;
  management_meta: ManagementMeta;
}

/** Persist the latest management assessment onto the outcome row. */
export async function updateManagement(
  db: Db,
  outcomeId: number,
  fields: ManagementUpdate,
): Promise<void> {
  if (!db) return;
  try {
    await db.update(signalOutcomes).set(fields).where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] updateManagement failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

export interface ManagementEventRow {
  outcome_id: number;
  symbol: string;
  kind: string;
  severity: ManagementSeverity;
  trade_health: number | null;
  current_confidence: number | null;
  price: number | null;
  pnl_pct: number | null;
  suggested_stop: number | null;
  details: unknown;
}

/** Append one management-event row (notified events + throttled heartbeats). */
export async function recordManagementEvent(db: Db, row: ManagementEventRow): Promise<void> {
  if (!db) return;
  try {
    await db.insert(tradeManagementEvents).values(row);
  } catch (err) {
    logger.warn(`[db] recordManagementEvent failed for outcome #${row.outcome_id}: ${(err as Error).message}`);
  }
}

/** Refresh a tracked position's SL/TP from the exchange (user moved them on Bybit). */
export async function updateOutcomeLevels(
  db: Db,
  outcomeId: number,
  levels: { sl?: number; tp?: number },
): Promise<void> {
  if (!db) return;
  try {
    await db.update(signalOutcomes).set(levels).where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] updateOutcomeLevels failed for #${outcomeId}: ${(err as Error).message}`);
  }
}

// ── Historical metrics ──────────────────────────────────────────────────────

export interface HistoricalMetrics {
  fundingHistory: number[];
  oiHistory: number[];
  atrHistory: number[];
  volumeHistory: number[];
  recordCount: number;
}

export async function fetchHistoricalMetricsFromDb(
  db: Db,
  symbol: string,
): Promise<HistoricalMetrics | null> {
  if (!db) return null;
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        funding_rate: metricHistory.funding_rate,
        open_interest: metricHistory.open_interest,
        atr: metricHistory.atr,
        volume_15m: metricHistory.volume_15m,
        recorded_at: metricHistory.recorded_at,
      })
      .from(metricHistory)
      .where(
        and(
          eq(metricHistory.symbol, symbol),
          gte(metricHistory.recorded_at, ninetyDaysAgo),
        ),
      )
      .orderBy(desc(metricHistory.recorded_at));

    if (rows.length === 0) {
      return {
        fundingHistory: [],
        oiHistory: [],
        atrHistory: [],
        volumeHistory: [],
        recordCount: 0,
      };
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const fundingHistory: number[] = [];
    const oiHistory: number[] = [];
    const atrHistory: number[] = [];
    const volumeHistory: number[] = [];

    for (const r of rows) {
      if (r.funding_rate !== null && Number.isFinite(r.funding_rate)) {
        fundingHistory.push(r.funding_rate);
      }
      if (r.open_interest !== null && Number.isFinite(r.open_interest)) {
        oiHistory.push(r.open_interest);
      }
      const recordTime = new Date(r.recorded_at).getTime();
      if (recordTime >= thirtyDaysAgo.getTime()) {
        if (r.atr !== null && Number.isFinite(r.atr)) {
          atrHistory.push(r.atr);
        }
        if (r.volume_15m !== null && Number.isFinite(r.volume_15m)) {
          volumeHistory.push(r.volume_15m);
        }
      }
    }

    fundingHistory.reverse();
    oiHistory.reverse();
    atrHistory.reverse();
    volumeHistory.reverse();

    return {
      fundingHistory,
      oiHistory,
      atrHistory,
      volumeHistory,
      recordCount: rows.length,
    };
  } catch (err) {
    logger.warn(`[db] fetchHistoricalMetricsFromDb failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

// ── Historical context from market_history (backfilled raw data) ─────────────

export interface MarketHistoryOptions {
  fundingDays: number;
  oiDays: number;
  /** Recent window (days) of candles used for ATR & volume percentiles. May be
   *  shorter than the full stored candle history (backfill.candle_days). */
  candleDays: number;
  atrPeriod: number;
}

/**
 * Build percentile/z-score windows from the backfilled raw market_history.
 * ATR and volume are derived from the raw candles on demand (never stored), so
 * indicator-formula changes never require a re-backfill.
 */
export async function fetchHistoricalContextFromMarketHistory(
  db: Db,
  symbol: string,
  opts: MarketHistoryOptions,
): Promise<HistoricalMetrics | null> {
  if (!db) return null;
  try {
    const now = Date.now();
    const maxDays = Math.max(opts.fundingDays, opts.oiDays, opts.candleDays);
    const since = new Date(now - maxDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        timestamp: marketHistory.timestamp,
        open: marketHistory.open,
        high: marketHistory.high,
        low: marketHistory.low,
        close: marketHistory.close,
        volume: marketHistory.volume,
        open_interest: marketHistory.open_interest,
        funding_rate: marketHistory.funding_rate,
      })
      .from(marketHistory)
      .where(and(eq(marketHistory.symbol, symbol), gte(marketHistory.timestamp, since)))
      .orderBy(asc(marketHistory.timestamp));

    if (rows.length === 0) {
      return { fundingHistory: [], oiHistory: [], atrHistory: [], volumeHistory: [], recordCount: 0 };
    }

    const fundingCutoff = now - opts.fundingDays * 24 * 60 * 60 * 1000;
    const oiCutoff = now - opts.oiDays * 24 * 60 * 60 * 1000;
    const candleCutoff = now - opts.candleDays * 24 * 60 * 60 * 1000;

    const fundingHistory: number[] = [];
    const oiHistory: number[] = [];
    const volumeHistory: number[] = [];
    const candles: Candle[] = [];

    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (r.funding_rate !== null && Number.isFinite(r.funding_rate) && t >= fundingCutoff) {
        fundingHistory.push(r.funding_rate);
      }
      if (r.open_interest !== null && Number.isFinite(r.open_interest) && t >= oiCutoff) {
        oiHistory.push(r.open_interest);
      }
      if (
        t >= candleCutoff &&
        r.open !== null && r.high !== null && r.low !== null && r.close !== null
      ) {
        candles.push({
          time: Math.floor(t / 1000),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume ?? 0,
        });
        if (r.volume !== null && Number.isFinite(r.volume)) volumeHistory.push(r.volume);
      }
    }

    // ATR is computed from the raw candles, oldest-first (already sorted asc).
    const atrHistory = atrSeries(candles, opts.atrPeriod).filter((v) => Number.isFinite(v));

    return {
      fundingHistory,
      oiHistory,
      atrHistory,
      volumeHistory,
      recordCount: candles.length,
    };
  } catch (err) {
    logger.warn(`[db] fetchHistoricalContextFromMarketHistory failed for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

export type MarketHistoryColumn = "open" | "open_interest" | "funding_rate";

/** Earliest/latest stored timestamps (unix ms) for a column, for gap-aware incremental backfill. */
export async function marketHistoryBounds(
  db: Db,
  symbol: string,
  column: MarketHistoryColumn,
): Promise<{ earliest: number | null; latest: number | null }> {
  if (!db) return { earliest: null, latest: null };
  try {
    const col = marketHistory[column];
    const rows = await db
      .select({ min: sql<string | null>`min(${marketHistory.timestamp})`, max: sql<string | null>`max(${marketHistory.timestamp})` })
      .from(marketHistory)
      .where(and(eq(marketHistory.symbol, symbol), isNotNull(col)));
    const r = rows[0];
    return {
      earliest: r?.min ? new Date(r.min).getTime() : null,
      latest: r?.max ? new Date(r.max).getTime() : null,
    };
  } catch (err) {
    logger.warn(`[db] marketHistoryBounds failed for ${symbol}/${column}: ${(err as Error).message}`);
    return { earliest: null, latest: null };
  }
}

export async function runRetentionCleanup(db: Db, rules: Rules): Promise<void> {
  if (!db) return;
  try {
    const now = new Date();
    logger.info("[retention] Running database retention cleanup...");

    const metricDays = rules.retention?.metric_history_days ?? 180;
    if (metricDays > 0) {
      const cutoff = new Date(now.getTime() - metricDays * 24 * 60 * 60 * 1000);
      await db.delete(metricHistory).where(lt(metricHistory.recorded_at, cutoff));
      logger.info(`[retention] Cleaned metric_history older than ${metricDays} days`);
    }

    const regimeDays = rules.retention?.regime_log_days ?? 90;
    if (regimeDays > 0) {
      const cutoff = new Date(now.getTime() - regimeDays * 24 * 60 * 60 * 1000);
      await db.delete(regimeLog).where(lt(regimeLog.computed_at, cutoff));
      logger.info(`[retention] Cleaned regime_log older than ${regimeDays} days`);
    }

    const edgeDays = rules.retention?.edge_updates_days ?? 90;
    if (edgeDays > 0) {
      const cutoff = new Date(now.getTime() - edgeDays * 24 * 60 * 60 * 1000);
      await db.delete(signalEdgeUpdates).where(lt(signalEdgeUpdates.recorded_at, cutoff));
      logger.info(`[retention] Cleaned signal_edge_updates older than ${edgeDays} days`);
    }

    const mgmtDays = rules.retention?.management_events_days ?? 90;
    if (mgmtDays > 0) {
      const cutoff = new Date(now.getTime() - mgmtDays * 24 * 60 * 60 * 1000);
      await db.delete(tradeManagementEvents).where(lt(tradeManagementEvents.recorded_at, cutoff));
      logger.info(`[retention] Cleaned trade_management_events older than ${mgmtDays} days`);
    }
  } catch (err) {
    logger.error(`[retention] Database cleanup failed: ${(err as Error).message}`);
  }
}
