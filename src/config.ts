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
  analytics: {
    default_window_days: number; // CLI/HTTP default window (0 = all-time)
    digest_every_hours: number; // scheduled Telegram digest cadence; 0 disables
    digest_window_days: number; // window the digest summarizes
  };
  retention: {
    metric_history_days: number;
    regime_log_days: number;
    edge_updates_days: number;
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
