// Loads and types config/*.yaml. Loaded once at startup.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const configDir = join(here, "..", "config");

export interface AssetConfig {
  symbol: string;
  enabled: boolean;
  scan_interval: number;
  min_confidence?: number;
  max_position_size_multiplier?: number;
  asset_class: string;
  notes?: string;
}

export interface GlobalConfig {
  min_confidence: number;
  min_setup_quality: number;
  alert_cooldown_min: number;
  max_alerts_per_hour: number;
  min_rr: number;
}

export interface Watchlist {
  global: GlobalConfig;
  assets: AssetConfig[];
}

export interface Rules {
  regime: {
    adx_period: number;
    ema_fast: number;
    ema_slow: number;
    atr_period: number;
    trending_adx: number;
    ranging_adx: number;
    ema_spread_flat: number;
    high_vol_atr_pct: number;
    low_vol_atr_pct: number;
  };
  trend: {
    confidence_floor: number;
    flash_timeout_ms: number;
    flash_lite_timeout_ms: number;
  };
  confidence_weights: {
    funding_percentile: number;
    oi_zscore: number;
    volume_percentile: number;
    regime_alignment: number;
  };
  setup_quality_weights: {
    sr_level_strength: number;
    engulf_body_ratio: number;
    htf_aligned: number;
    sweep_wick_ratio: number;
    structure_intact: number;
  };
  squeeze: {
    enabled: boolean;
    funding_extreme_low: number;
    funding_extreme_high: number;
    oi_zscore_min: number;
    oi_zscore_max: number;
  };
  risk: {
    atr_sl_mult: number; // stop distance >= this * ATR(15m)
    min_sl_pct: number; // floor on stop distance, percent of price
    max_sl_pct: number; // cap on stop distance, percent of price
  };
  momentum: {
    enabled: boolean;
    lookback_1m: number; // window of 1m candles to measure the move
    min_move_pct: number; // |move| over the window to qualify (percent)
    vol_mult: number; // latest volume >= this * window-average volume
    tp_r: number; // take-profit R-multiple when no S/R target
    max_final_candle_frac: number; // reject if > this fraction of the move is one bar
  };
  lifecycle: {
    weakening_confidence_drop: number; // ACTIVE → EDGE_WEAKENING
    invalidate_confidence_floor: number; // live confidence at/below → INVALIDATED (critical)
    invalidate_min_failures: number; // # of soft failures required for INVALIDATED
    invalidate_grace_min: number; // no INVALIDATED within this many minutes of creation
    require_follow: boolean; // signals require a Follow press to be tracked (Telegram only)
    update_confidence_delta: number; // notify if live conf moves >= this since last notify
    update_min_interval_min: number; // min minutes between non-state-change updates
    edge_history_min_delta: number; // append history row when live conf moves >= this
    edge_history_min_interval_min: number; // ...or at least this often (heartbeat)
  };
  management: {
    enabled: boolean; // master switch for the 1-minute trade manager
    // Plan triggers (R multiples of the initial risk).
    breakeven_at_r: number; // at +this R → suggest SL to breakeven
    lock_at_r: number; // at +this R → suggest locking partial profit
    lock_fraction: number; // fraction of position to lock at lock_at_r (0-1)
    resistance_partial_fraction: number; // partial to take when volume weakens near TP/level (0-1)
    // Rejection detection (1m candles).
    rejection_window: number; // 1m candles inspected
    rejection_wicks_min: number; // rejection wicks within window => signal
    rejection_wick_body: number; // wick >= this × body to count as a rejection wick
    volume_decline_pct: number; // directional volume down >= this % half-over-half => declining
    body_weakening_pct: number; // avg candle body shrink >= this % => weakening
    // Momentum decay (15m candles).
    decay_vol_contraction: number; // recent/prior volume ratio below this => contraction
    decay_atr_contraction: number; // ATR now / lookback-ago below this => contraction
    decay_adx_drop: number; // ADX points lost vs lookback => decline
    decay_lookback: number; // 15m bars for ATR/ADX comparisons
    // Adaptive stop suggestions.
    trail_atr_mult: number; // ATR trailing distance multiplier
    trail_ema_period: number; // EMA period for EMA trailing (15m)
    stop_buffer_pct: number; // buffer beyond structure/swing levels (% of price)
    min_stop_improve_r: number; // suggest only if it removes >= this fraction of initial risk
    // Trade health weights (must sum to 100).
    health_weights: {
      structure: number;
      momentum: number;
      volume: number;
      trend_alignment: number;
      risk_protection: number;
    };
    // Alerting & persistence throttles.
    health_alert_drop: number; // notify when health falls >= this since last alert
    update_min_interval_min: number; // min minutes between routine in-place report edits
    event_cooldown_min: number; // per event-kind cooldown for warning alerts
    emergency_confidence_floor: number; // live confidence below this => emergency exit condition
    history_min_interval_min: number; // append health history row at least this often
    history_min_health_delta: number; // ...or when health moved >= this
  };
  analytics: {
    default_window_days: number; // CLI/HTTP default window (0 = all-time)
    digest_every_hours: number; // scheduled Telegram digest cadence; 0 disables
    digest_window_days: number; // window the digest summarizes
  };
  retention: {
    metric_history_days: number;
    regime_log_days: number;
    edge_updates_days: number;
    management_events_days: number;
  };
  backfill: {
    funding_days: number;
    oi_days: number;
    candle_days: number; // 15m candle storage window
    percentile_days: number; // recent window for ATR/volume percentiles at scan time
    oi_interval: string; // Bybit intervalTime: 5min|15min|30min|1h|4h|1d
    min_funding: number;
    min_oi: number;
    min_volume: number;
    min_candles: number;
  };
}

function load<T>(file: string): T {
  return parse(readFileSync(join(configDir, file), "utf8")) as T;
}

export function loadWatchlist(): Watchlist {
  const raw = load<{ global: GlobalConfig; assets: Record<string, Omit<AssetConfig, "symbol">> }>(
    "watchlist.yaml",
  );
  const assets: AssetConfig[] = Object.entries(raw.assets).map(([symbol, cfg]) => ({
    symbol,
    ...cfg,
  }));
  return { global: raw.global, assets };
}

const LIFECYCLE_DEFAULTS: Rules["lifecycle"] = {
  weakening_confidence_drop: 20,
  invalidate_confidence_floor: 35,
  invalidate_min_failures: 2,
  invalidate_grace_min: 5,
  require_follow: true,
  update_confidence_delta: 15,
  update_min_interval_min: 10,
  edge_history_min_delta: 3,
  edge_history_min_interval_min: 5,
};

const RETENTION_DEFAULTS: Rules["retention"] = {
  metric_history_days: 180,
  regime_log_days: 90,
  edge_updates_days: 90,
  management_events_days: 90,
};

const MANAGEMENT_DEFAULTS: Rules["management"] = {
  enabled: true,
  breakeven_at_r: 1.0,
  lock_at_r: 1.5,
  lock_fraction: 0.3,
  resistance_partial_fraction: 0.25,
  rejection_window: 10,
  rejection_wicks_min: 3,
  rejection_wick_body: 1.5,
  volume_decline_pct: 30,
  body_weakening_pct: 40,
  decay_vol_contraction: 0.7,
  decay_atr_contraction: 0.8,
  decay_adx_drop: 5,
  decay_lookback: 10,
  trail_atr_mult: 2.0,
  trail_ema_period: 21,
  stop_buffer_pct: 0.15,
  min_stop_improve_r: 0.1,
  health_weights: {
    structure: 25,
    momentum: 25,
    volume: 15,
    trend_alignment: 15,
    risk_protection: 20,
  },
  health_alert_drop: 15,
  update_min_interval_min: 10,
  event_cooldown_min: 45,
  emergency_confidence_floor: 45,
  history_min_interval_min: 10,
  history_min_health_delta: 5,
};

const ANALYTICS_DEFAULTS: Rules["analytics"] = {
  default_window_days: 30,
  digest_every_hours: 168,
  digest_window_days: 7,
};

const RISK_DEFAULTS: Rules["risk"] = {
  atr_sl_mult: 1.5,
  min_sl_pct: 0.4,
  max_sl_pct: 5.0,
};

const MOMENTUM_DEFAULTS: Rules["momentum"] = {
  enabled: true,
  lookback_1m: 7,
  min_move_pct: 1.5,
  vol_mult: 1.2,
  tp_r: 2.5,
  max_final_candle_frac: 0.7,
};

const SQUEEZE_DEFAULTS: Rules["squeeze"] = {
  enabled: false, // disabled pending evidence
  funding_extreme_low: 10,
  funding_extreme_high: 90,
  oi_zscore_min: 1.0,
  oi_zscore_max: -1.0,
};

export function loadRules(): Rules {
  const rules = load<Rules>("rules.yaml");
  // Backfill newer config blocks so a rules.yaml predating them still loads.
  rules.lifecycle = { ...LIFECYCLE_DEFAULTS, ...(rules.lifecycle ?? {}) };
  rules.retention = { ...RETENTION_DEFAULTS, ...(rules.retention ?? {}) };
  rules.analytics = { ...ANALYTICS_DEFAULTS, ...(rules.analytics ?? {}) };
  rules.risk = { ...RISK_DEFAULTS, ...(rules.risk ?? {}) };
  rules.momentum = { ...MOMENTUM_DEFAULTS, ...(rules.momentum ?? {}) };
  rules.squeeze = { ...SQUEEZE_DEFAULTS, ...(rules.squeeze ?? {}) };
  rules.management = {
    ...MANAGEMENT_DEFAULTS,
    ...(rules.management ?? {}),
    health_weights: {
      ...MANAGEMENT_DEFAULTS.health_weights,
      ...(rules.management?.health_weights ?? {}),
    },
  };
  return rules;
}

export interface Env {
  geminiApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  redisUrl?: string;
  databaseUrl?: string;
  bybitCategory: string;
  /** Read-only Bybit API credentials. When both are set, the position reconciler
   *  autodetects and tracks real open positions. Used ONLY to read positions — the
   *  bot never places, modifies, or closes orders. */
  bybitApiKey?: string;
  bybitApiSecret?: string;
  /** Health endpoint port. Set to 0/empty to disable the health server. */
  healthPort: number;
  /** Health endpoint bind address. Defaults to loopback (proxy/tunnel to expose). */
  healthHost: string;
  /** Send startup/shutdown/crash alerts via the notifier (default: on). */
  opsAlerts: boolean;
  /** Market data source in loop mode: "ws" (streamed) or "rest" (per-scan polling). */
  marketFeed: "ws" | "rest";
}

export function loadEnv(): Env {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    redisUrl: process.env.REDIS_URL || undefined,
    databaseUrl: process.env.DATABASE_URL || undefined,
    bybitCategory: process.env.BYBIT_CATEGORY || "linear",
    bybitApiKey: process.env.BYBIT_API_KEY || undefined,
    bybitApiSecret: process.env.BYBIT_API_SECRET || undefined,
    healthPort: process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : 3000,
    healthHost: process.env.HEALTH_HOST || "127.0.0.1",
    opsAlerts: process.env.OPS_ALERTS !== "false",
    marketFeed: process.env.MARKET_FEED === "rest" ? "rest" : "ws",
  };
}
