// Metric history accumulation. Records per-scan data into Postgres for
// building percentile/z-score windows over time.
// Also handles signal outcome persistence.
import type { Db } from "./index.js";
import type { MarketContext, RegimeResult, TrendResult, Signal, StrategyKind } from "../types.js";
import type { Rules } from "../config.js";
import { ENTRY_TTL } from "../types.js";
import { metricHistory, signals as signalsTable, regimeLog, signalOutcomes } from "./schema.js";
import { atr, adx, ema } from "../indicators.js";
import { logger } from "../logger.js";
import { desc, eq, gte, lt, and, sql, inArray } from "drizzle-orm";


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
    const closes4h = ctx.candles4h.map((c) => c.close);
    const lastCandle = ctx.candles15m.at(-1);

    await db.insert(metricHistory).values({
      symbol: ctx.symbol,
      funding_rate: ctx.fundingRate,
      open_interest: ctx.openInterest,
      atr: atr(ctx.candles15m, 14),
      adx: adx(ctx.candles15m, 14),
      volume_15m: lastCandle?.volume ?? null,
      ema20: ema(closes4h, 20),
      ema50: ema(closes4h, 50),
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

// ── Outcome persistence ─────────────────────────────────────────────────────

/**
 * Create an outcome row in PENDING_ENTRY status.
 * expires_at is set to now + entry_ttl (time allowed to reach entry zone).
 */
export async function createOutcome(
  db: Db,
  signal: Signal,
  signalId: number,
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
      status: "PENDING_ENTRY",
      entry_price: (signal.entry_low + signal.entry_high) / 2,
      entry_low: signal.entry_low,
      entry_high: signal.entry_high,
      sl: signal.sl,
      tp: signal.tp,
      opened_at: now,
      expires_at: expiresAt,
    });
    logger.info(`[outcome] Created PENDING_ENTRY for ${signal.symbol} ${signal.direction} ${signal.strategy} (signal #${signalId})`);
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
}

/** Fetch all outcomes that need evaluation (PENDING_ENTRY or ACTIVE). */
export async function fetchOpenOutcomes(db: Db): Promise<OutcomeRow[]> {
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(signalOutcomes)
      .where(inArray(signalOutcomes.status, ["PENDING_ENTRY", "ACTIVE"]));
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

/** Close an outcome with a terminal status. */
export async function closeOutcome(
  db: Db,
  outcomeId: number,
  status: "TP_HIT" | "SL_HIT" | "EXPIRED",
  hitPrice: number | null,
  closedAt: Date,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .update(signalOutcomes)
      .set({
        status,
        hit_price: hitPrice,
        closed_at: closedAt,
      })
      .where(eq(signalOutcomes.id, outcomeId));
  } catch (err) {
    logger.warn(`[db] closeOutcome failed for #${outcomeId}: ${(err as Error).message}`);
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
  } catch (err) {
    logger.error(`[retention] Database cleanup failed: ${(err as Error).message}`);
  }
}
