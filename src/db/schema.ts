// Drizzle schema — metric_history, signals, regime_log, signal_outcomes tables.
// All persistence is optional; if DATABASE_URL is not set, these are never used.
import { pgTable, serial, text, real, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── market_history ────────────────────────────────────────────────────────────
// Raw historical market data backfilled from Bybit (and the single source of
// truth for percentile/z-score windows). One row per (symbol, timestamp).
//
// Rows are sparse by design: candle backfill populates OHLCV, OI backfill
// populates open_interest, funding backfill populates funding_rate. When the
// timestamps coincide (e.g. on an hour boundary) the backfillers merge into the
// same row via upsert. Derived indicators (ATR, volatility) are NOT stored —
// they are computed on demand from the raw candles so formula changes never
// require a re-backfill.
export const marketHistory = pgTable(
  "market_history",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    open_interest: real("open_interest"),
    funding_rate: real("funding_rate"),
  },
  (t) => [
    uniqueIndex("uq_market_symbol_time").on(t.symbol, t.timestamp),
  ],
);

// ── metric_history ──────────────────────────────────────────────────────────
// One row per symbol per scan. Accumulates the raw data needed for percentile
// and z-score windows (funding, OI, ATR, ADX, volume, EMAs).
export const metricHistory = pgTable(
  "metric_history",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    funding_rate: real("funding_rate"),
    open_interest: real("open_interest"),
    atr: real("atr"),
    adx: real("adx"),
    volume_15m: real("volume_15m"),
    ema20: real("ema20"),
    ema50: real("ema50"),
    price: real("price").notNull(),
  },
  (t) => [
    index("idx_metric_symbol_time").on(t.symbol, t.recorded_at),
  ],
);

// ── signals ─────────────────────────────────────────────────────────────────
// Every signal that passes gates. Full payload as JSONB + indexed columns for
// querying win-rate, strategy performance, etc.
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    strategy: text("strategy").notNull(),
    direction: text("direction").notNull(),
    confidence: integer("confidence").notNull(),
    setup_quality: integer("setup_quality").notNull(),
    rr: real("rr").notNull(),
    regime: text("regime").notNull(),
    trend: text("trend").notNull(),
    trend_source: text("trend_source").notNull(),
    payload: jsonb("payload").notNull(), // full Signal object
    detected_at: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_signal_symbol_time").on(t.symbol, t.detected_at),
    index("idx_signal_strategy").on(t.strategy),
  ],
);

// ── regime_log ──────────────────────────────────────────────────────────────
// Regime classification per symbol per scan. For backtesting regime accuracy.
export const regimeLog = pgTable(
  "regime_log",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    regime: text("regime").notNull(),
    adx: real("adx").notNull(),
    atr_percentile: real("atr_percentile").notNull(),
    ema_spread_pct: real("ema_spread_pct").notNull(),
    computed_at: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_regime_symbol_time").on(t.symbol, t.computed_at),
  ],
);

// ── signal_outcomes ─────────────────────────────────────────────────────────
// Tracks each signal's lifecycle: PENDING_ENTRY → ACTIVE → TP_HIT | SL_HIT | EXPIRED.
// The 1-minute evaluator polls rows with status IN ('PENDING_ENTRY','ACTIVE').
export const signalOutcomes = pgTable(
  "signal_outcomes",
  {
    id: serial("id").primaryKey(),
    signal_id: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    strategy: text("strategy").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull().default("PENDING_ENTRY"),
    entry_price: real("entry_price").notNull(),
    entry_low: real("entry_low").notNull(),
    entry_high: real("entry_high").notNull(),
    sl: real("sl").notNull(),
    tp: real("tp").notNull(),
    hit_price: real("hit_price"),
    opened_at: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    activated_at: timestamp("activated_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_outcome_status").on(t.status),
    index("idx_outcome_signal_id").on(t.signal_id),
  ],
);

