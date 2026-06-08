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
    funding_extreme_low: number;
    funding_extreme_high: number;
    oi_zscore_min: number;
    oi_zscore_max: number;
  };
  lifecycle: {
    weakening_confidence_drop: number; // ACTIVE → EDGE_WEAKENING
    invalidate_confidence_floor: number; // live confidence at/below → INVALIDATED (critical)
    invalidate_min_failures: number; // # of soft failures required for INVALIDATED
    update_confidence_delta: number; // notify if live conf moves >= this since last notify
    update_min_interval_min: number; // min minutes between non-state-change updates
    edge_history_min_delta: number; // append history row when live conf moves >= this
    edge_history_min_interval_min: number; // ...or at least this often (heartbeat)
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

export function loadRules(): Rules {
  const rules = load<Rules>("rules.yaml");
  // Backfill newer config blocks so a rules.yaml predating them still loads.
  rules.lifecycle = { ...LIFECYCLE_DEFAULTS, ...(rules.lifecycle ?? {}) };
  rules.retention = { ...RETENTION_DEFAULTS, ...(rules.retention ?? {}) };
  return rules;
}

export interface Env {
  geminiApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  redisUrl?: string;
  databaseUrl?: string;
  bybitCategory: string;
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
    healthPort: process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : 3000,
    healthHost: process.env.HEALTH_HOST || "127.0.0.1",
    opsAlerts: process.env.OPS_ALERTS !== "false",
    marketFeed: process.env.MARKET_FEED === "rest" ? "rest" : "ws",
  };
}
