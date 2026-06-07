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
  retention: Record<string, number>;
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

export function loadRules(): Rules {
  return load<Rules>("rules.yaml");
}

export interface Env {
  geminiApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  redisUrl?: string;
  bybitCategory: string;
}

export function loadEnv(): Env {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    redisUrl: process.env.REDIS_URL || undefined,
    bybitCategory: process.env.BYBIT_CATEGORY || "linear",
  };
}
