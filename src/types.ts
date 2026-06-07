// Shared domain types for the signal bot.

export interface Candle {
  time: number; // unix seconds (open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "1m" | "15m" | "4h";

// ── Regime engine ─────────────────────────────────────────────────────────────
export type Regime = "trending" | "ranging" | "high_volatility" | "low_volatility";

export interface RegimeResult {
  regime: Regime;
  adx: number;
  atrPercentile: number;
  emaSpreadPct: number;
  /** Strategies the regime permits to run. */
  allowedStrategies: StrategyKind[];
  computedAt: number;
}

// ── AI trend classifier ───────────────────────────────────────────────────────
export type Trend = "bullish" | "bearish" | "neutral";

export interface TrendResult {
  trend: Trend;
  confidence: number; // 0-100
  source: "gemini_flash" | "gemini_flash_lite" | "ema_adx_fallback";
  reasoning?: string;
  keyLevels?: { support: number; resistance: number };
}

// ── S/R engine ────────────────────────────────────────────────────────────────
export interface SRLevel {
  price: number;
  kind: "support" | "resistance";
  touches: number;
  strength: number; // 0-100
}

export interface SRSnapshot {
  support: SRLevel | null;
  resistance: SRLevel | null;
  levels: SRLevel[];
}

// ── Strategy / signals ────────────────────────────────────────────────────────
export type StrategyKind = "liquidity_sweep" | "trend_pullback" | "squeeze";
export type Direction = "long" | "short";

export interface ScoreBreakdown {
  // confidence (market conditions)
  funding_percentile: number;
  oi_zscore: number;
  volume_percentile: number;
  regime_alignment: number;
  // setup quality (technical structure)
  sr_level_strength: number;
  engulf_body_ratio: number;
  htf_aligned: boolean;
  sweep_wick_ratio?: number;
  structure_intact: boolean;
}

export interface Signal {
  symbol: string;
  strategy: StrategyKind;
  direction: Direction;

  entry_low: number;
  entry_high: number;
  sl: number;
  tp: number;
  rr: number;

  confidence: number; // 0-100, market conditions
  setup_quality: number; // 0-100, technical structure
  score_breakdown: ScoreBreakdown;

  regime: Regime;
  trend: Trend;
  trend_source: TrendResult["source"];

  snapshot: {
    price: number;
    support: SRLevel | null;
    resistance: SRLevel | null;
    funding_rate: number | null;
    open_interest: number | null;
  };

  detected_at: number;
}

// Per-symbol market data assembled once per scan.
export interface MarketContext {
  symbol: string;
  candles1m: Candle[];
  candles15m: Candle[];
  candles4h: Candle[];
  fundingRate: number | null;
  openInterest: number | null;
  fundingHistory: number[]; // recent funding rates for percentile
  oiHistory: number[]; // recent OI for z-score
}
