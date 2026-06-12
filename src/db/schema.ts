// Drizzle schema — metric_history, signals, regime_log, signal_outcomes tables.
// All persistence is optional; if DATABASE_URL is not set, these are never used.
import { pgTable, serial, text, real, doublePrecision, timestamp, jsonb, integer, bigint, boolean, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

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

// ── candles ───────────────────────────────────────────────────────────────────
// Historical OHLCV store for the strategy engine (src/data/history/). One row
// per (symbol, timeframe, open time); only CLOSED bars are written. Distinct
// from market_history (legacy percentile windows): this table is the
// MarketDataProvider's backing store and supports 15m/1h/4h/1d.
// Composite PK = natural idempotency: re-running a backfill cannot duplicate.
export const candlesTable = pgTable(
  "candles",
  {
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(), // '15m' | '1h' | '4h' | '1d'
    time: bigint("time", { mode: "number" }).notNull(), // unix seconds, bar open
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.timeframe, t.time] })],
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
    // Human action via the Telegram Follow/Skip buttons (null = undecided).
    decision: text("decision"), // 'followed' | 'skipped'
    decided_at: timestamp("decided_at", { withTimezone: true }),
    // Telegram message of the alert, so edge updates can edit it in place (no spam).
    // is_photo selects editMessageCaption (chart alert) vs editMessageText (text alert).
    alert_message_id: integer("alert_message_id"),
    alert_is_photo: boolean("alert_is_photo").notNull().default(false),
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
    // Provenance of the tracked trade. 'signal' = a detected signal the user Followed
    // (or a shadow). 'bybit' = a real open position autodetected from the exchange
    // (signal_id is a 0 sentinel for these; there is no FK). Bybit rows are exited by
    // the position reconciler when the position disappears, not by the price tracker.
    source: text("source").notNull().default("signal"),
    // A followed outcome is a real tracked trade; a shadow outcome (followed=false,
    // created when a signal is Skipped) is evaluated silently for counterfactual data
    // but is excluded from edge monitoring, notifications, and the active-slot check.
    followed: boolean("followed").notNull().default(true),
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

    // ── Edge lifecycle (orthogonal to price `status`) ─────────────────────────
    // Originals are immutable; live_* are recomputed each monitor pass.
    original_confidence: integer("original_confidence"),
    original_setup_quality: integer("original_setup_quality"),
    live_confidence: integer("live_confidence"),
    live_setup_quality: integer("live_setup_quality"),
    edge_state: text("edge_state").notNull().default("ACTIVE"),
    original_factors: jsonb("original_factors"), // funding_percentile, oi_zscore, … at creation
    live_factors: jsonb("live_factors"), // latest recompute
    updated_at: timestamp("updated_at", { withTimezone: true }), // touched each monitor pass
    duration_ms: integer("duration_ms"), // closed_at − opened_at, set on close
    // Telegram-update throttle bookkeeping.
    last_update_sent_at: timestamp("last_update_sent_at", { withTimezone: true }),
    last_notified_confidence: integer("last_notified_confidence"),
    // signal_edge_updates write-gate bookkeeping (avoid row bloat).
    last_edge_record_at: timestamp("last_edge_record_at", { withTimezone: true }),
    last_recorded_confidence: integer("last_recorded_confidence"),
    // Telegram message to edit in place on each update (edge update for signals, live
    // PnL refresh for Bybit positions) — so a single message tracks the trade's life
    // instead of a new message per change. is_photo selects caption vs text edit.
    notify_message_id: integer("notify_message_id"),
    notify_is_photo: boolean("notify_is_photo").notNull().default(false),

    // ── Trade management (orthogonal to price `status` and `edge_state`) ───────
    // NONE → MONITORING (manager has scanned it) → MANAGED (>=1 action suggested).
    // Together with `status` this is the user-facing lifecycle: PENDING_ENTRY=PENDING,
    // ACTIVE=FILLED/ACTIVE, ACTIVE+MANAGED=MANAGED, terminal status=EXITED.
    management_state: text("management_state").notNull().default("NONE"),
    trade_health: integer("trade_health"), // latest 0-100 health total
    health_components: jsonb("health_components"), // HealthComponents breakdown
    suggested_stop: real("suggested_stop"), // latest adaptive stop suggestion
    suggested_stop_method: text("suggested_stop_method"), // swing|atr|ema|structure
    management_plan: jsonb("management_plan"), // ManagementPlan, generated at signal time
    path_probs: jsonb("path_probs"), // latest PathProbabilities (seeded at creation)
    // Latest full assessment surface (observations/warnings/actions/emergency) so
    // /running Details can render the trade report without recomputing market data.
    management_snapshot: jsonb("management_snapshot"),
    // Manager bookkeeping (event cooldowns, last health band, throttle timestamps).
    // One JSONB blob: bookkeeping only, never queried.
    management_meta: jsonb("management_meta"),

    // ── Strategy-agnostic engine (source='engine' rows; see MIGRATION_PLAN.md) ──
    // Additive only — legacy rows leave them null. `tp = 0` is the existing
    // "no target" sentinel (same convention as Bybit rows).
    strategy_state: jsonb("strategy_state"), // opaque per-position strategy memory
    entry_reasons: jsonb("entry_reasons"), // string[] — strategy-authored entry explanation
    qty: real("qty"), // sized by the risk engine (0 = advisory)
    risk_amount: real("risk_amount"), // quote at risk if the stop is hit
    risk_model: text("risk_model"), // sizing model id
    age_bars: integer("age_bars"), // closed bars since fill
    exit_reason: text("exit_reason"), // engine exit reason (stop hit, trail, …)
    max_hold_sec: integer("max_hold_sec"), // strategy holding horizon (s from fill)
  },
  (t) => [
    index("idx_outcome_status").on(t.status),
    index("idx_outcome_signal_id").on(t.signal_id),
    index("idx_outcome_symbol_status").on(t.symbol, t.status),
  ],
);

// ── signal_edge_updates ───────────────────────────────────────────────────────
// Edge-evolution time series: one row appended per open outcome when its edge
// meaningfully changes (state change, confidence delta, or sparse heartbeat). Raw
// data for analyzing confidence decay and factor evolution — cannot be
// reconstructed retroactively, so it is captured as it happens.
// ── trade_management_events ───────────────────────────────────────────────────
// Management-event time series: one row per notified event plus throttled health
// heartbeats (kind='health_snapshot'). Like signal_edge_updates, this is raw
// history that cannot be reconstructed retroactively — captured as it happens,
// write-gated by the manager to bound row growth.
export const tradeManagementEvents = pgTable(
  "trade_management_events",
  {
    id: serial("id").primaryKey(),
    outcome_id: integer("outcome_id").notNull(),
    symbol: text("symbol").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(), // ManagementEventKind
    severity: text("severity").notNull(), // info | warning | critical
    trade_health: integer("trade_health"),
    current_confidence: integer("current_confidence"),
    price: real("price"),
    pnl_pct: real("pnl_pct"),
    suggested_stop: real("suggested_stop"),
    details: jsonb("details"), // event happened/actions, health components, paths
  },
  (t) => [
    index("idx_mgmt_event_outcome_time").on(t.outcome_id, t.recorded_at),
  ],
);

export const signalEdgeUpdates = pgTable(
  "signal_edge_updates",
  {
    id: serial("id").primaryKey(),
    outcome_id: integer("outcome_id").notNull(),
    signal_id: integer("signal_id").notNull(),
    symbol: text("symbol").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    edge_state: text("edge_state").notNull(),
    live_confidence: integer("live_confidence").notNull(),
    live_setup_quality: integer("live_setup_quality").notNull(),
    funding_percentile: real("funding_percentile"),
    oi_zscore: real("oi_zscore"),
    volume_percentile: real("volume_percentile"),
    structure_intact: boolean("structure_intact"),
    trend: text("trend"),
    trend_aligned: boolean("trend_aligned"),
    regime_aligned: boolean("regime_aligned"),
  },
  (t) => [
    index("idx_edge_update_outcome_time").on(t.outcome_id, t.recorded_at),
  ],
);

