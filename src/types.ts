// Shared domain types for the signal bot.

export interface Candle {
  time: number; // unix seconds (open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Timeframe stack: 1m = entry trigger, 15m = structure/regime, 1h = bias,
// 4h/1d = higher-timeframe history for the strategy engine.
export type Timeframe = "1m" | "15m" | "1h" | "4h" | "1d";

/** Bar length in seconds per timeframe. */
export const TIMEFRAME_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
};

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
export type StrategyKind = "liquidity_sweep" | "trend_pullback" | "squeeze" | "momentum";
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

  // ── Trade management (attached after gates pass, before alert) ────────────
  /** Conditional exit plan (Base/Protection/Aggressive/Emergency). */
  plan?: ManagementPlan;
  /** Expected-path probabilities at detection time. */
  paths?: PathProbabilities;
}

// ── Expected-path chart overlay ────────────────────────────────────────────
// Calculated per strategy from a Signal + the rendered candle series. Anchors
// markers to real candle times and projects a dotted path from entry to TP so
// the reader can approve/reject the setup at a glance.
export interface PathMarker {
  time: number; // unix seconds — must match a rendered candle's time
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text?: string;
}

export interface PathPoint {
  time: number; // unix seconds
  value: number; // price
}

export interface PathZone {
  from: number; // price
  to: number; // price
  color: string; // rgba fill
  label?: string;
}

// A filled horizontal price band (entry zone, risk/reward shading, S/R zones, and
// future overlays: FVG boxes, order blocks, liquidity zones). The renderer draws
// each as a non-occluding baseline fill, so adding a new overlay type is just
// another band with its own `kind`/color — no layout change required.
export type BandKind =
  | "entry"
  | "reward"
  | "risk"
  | "support"
  | "resistance"
  | "fvg"
  | "order_block"
  | "liquidity";

export interface PathBand {
  from: number; // price (lower or upper — renderer normalizes)
  to: number; // price
  color: string; // rgba fill
  kind: BandKind;
  label?: string;
}

export interface PathOverlay {
  markers: PathMarker[];
  projectionLine: PathPoint[];
  /** Colour of the projection line/arrow (direction-aware: green long, red short). */
  projectionColor?: string;
  /** @deprecated superseded by `bands`; kept for back-compat, always []. */
  zones: PathZone[];
  /** Filled price bands (entry / risk / reward / S-R zones / future overlays). */
  bands: PathBand[];
  /** Detected-feature chips to render (LONG, MOMENTUM, VOLUME SPIKE, …). */
  tags: string[];
}

// Per-symbol market data assembled once per scan.
export interface MarketContext {
  symbol: string;
  candles1m: Candle[]; // entry trigger
  candles15m: Candle[]; // structure + regime
  candles1h: Candle[]; // higher-timeframe bias (trend classifier)
  fundingRate: number | null;
  openInterest: number | null;
  fundingHistory: number[]; // recent funding rates for percentile
  oiHistory: number[]; // recent OI for z-score
  atrHistory?: number[];
  volumeHistory?: number[];
  historyConfidence: number;
}

// Mock scenario selector for deterministic offline testing.
export type MockScenario = "sweep" | "pullback" | "squeeze";

// ── Signal lifecycle: edge health ──────────────────────────────────────────────
// Orthogonal to the price-based OutcomeStatus below. `status` answers "did price
// enter / hit TP/SL / expire"; `EdgeState` answers "does the original thesis still
// hold". Edge state is tracked while a signal is open and never closes a trade.
export type EdgeState = "ACTIVE" | "EDGE_WEAKENING" | "INVALIDATED";

/** A recompute of a signal's edge from current market data (vs its immutable original). */
export interface EdgeSnapshot {
  confidence: number; // 0-100, recomputed market-conditions score
  setup_quality: number; // 0-100, recomputed structure score
  funding_percentile: number;
  oi_zscore: number;
  volume_percentile: number;
  structure_intact: boolean;
  trend: Trend;
  trend_aligned: boolean; // current trend still agrees with signal direction
  regime_aligned: boolean; // current regime still permits the signal's strategy
}

/** Payload for a Telegram/console "signal update" (edge changed, not a new signal). */
export interface SignalUpdate {
  symbol: string;
  direction: Direction;
  strategy: StrategyKind;
  edgeState: EdgeState;
  original: { confidence: number; funding_percentile: number; oi_zscore: number };
  live: { confidence: number; funding_percentile: number; oi_zscore: number };
  reasons: string[];
}

// ── Trade management ──────────────────────────────────────────────────────────
// Active-trade management layer, orthogonal to both price `status` and `edge_state`.
// Maps onto the user-facing lifecycle: PENDING (=PENDING_ENTRY) → FILLED/ACTIVE
// (=ACTIVE) → MANAGED (=ACTIVE + management_state MANAGED) → EXITED (terminal status).
// The manager only ever SUGGESTS actions — the bot stays read-only on the exchange.

/** NONE = not yet picked up · MONITORING = scanned every minute, nothing to do yet ·
 *  MANAGED = at least one management action has been suggested for this trade. */
export type ManagementState = "NONE" | "MONITORING" | "MANAGED";

export type HealthBand = "excellent" | "healthy" | "neutral" | "weak" | "exit_candidate";

export interface HealthComponents {
  structure: number; // 0-100
  momentum: number;
  volume: number;
  trend_alignment: number;
  risk_protection: number;
}

export interface TradeHealth {
  total: number; // 0-100, weighted blend of components
  band: HealthBand;
  components: HealthComponents;
}

/** Classification bands for the trade health total. */
export function healthBand(total: number): HealthBand {
  if (total >= 85) return "excellent";
  if (total >= 70) return "healthy";
  if (total >= 55) return "neutral";
  if (total >= 40) return "weak";
  return "exit_candidate";
}

/** Expected-path split — integers that sum to 100. */
export interface PathProbabilities {
  tp_direct: number; // Path A: TP hit directly
  retest_then_tp: number; // Path B: retest entry/support, then TP
  sl_hit: number; // Path C: SL hit
}

/** Trailing-stop family, chosen per regime (see management/stops.ts). */
export type StopMethod = "swing" | "atr" | "ema" | "structure";

export interface StopSuggestion {
  price: number;
  method: StopMethod;
  reasons: string[];
  /** Risk removed vs the current stop, in R of the initial risk (0 when no prior stop). */
  improves_r: number;
}

/** One conditional rule of the management plan ("If X → do Y"). */
export interface PlanRule {
  trigger: string;
  action: string;
}

export interface ManagementPlan {
  base: { entry_low: number; entry_high: number; sl: number; tp: number };
  protection: PlanRule[];
  aggressive: PlanRule[];
  emergency: PlanRule[];
  /** Regime-chosen trailing method for the runner. */
  trail_method: StopMethod;
}

export type ManagementEventKind =
  | "rejection_risk"
  | "momentum_decay"
  | "liquidity_sweep"
  | "stop_hunt"
  | "breakout_trap"
  | "health_drop"
  | "stop_suggestion"
  | "thesis_invalidated"
  | "emergency_exit"
  | "health_snapshot"; // throttled history heartbeat, never notified

export type ManagementSeverity = "info" | "warning" | "critical";

/** An action-oriented management event: what happened / why it matters / what to do. */
export interface ManagementEvent {
  kind: ManagementEventKind;
  severity: ManagementSeverity;
  title: string;
  happened: string[];
  matters: string;
  actions: string[];
}

/** Full per-minute assessment of one active trade. */
export interface TradeAssessment {
  symbol: string;
  direction: Direction;
  price: number;
  pnlPct: number;
  pnlR: number | null; // null when initial risk is unknown (e.g. Bybit position without SL)
  health: TradeHealth;
  entryConfidence: number | null;
  currentConfidence: number | null; // edge monitor's live confidence (signal trades only)
  observations: string[]; // ✓ lines
  warnings: string[]; // ⚠ lines
  actions: string[]; // ordered suggested actions
  events: ManagementEvent[]; // newly detected this pass (pre-throttle)
  stop: StopSuggestion | null;
  paths: PathProbabilities | null;
  emergency: string[]; // live "exit immediately if" conditions
}

// ── Outcome tracking ─────────────────────────────────────────────────────────
// CLOSED is terminal for autodetected Bybit positions: the user closed the position
// on the exchange (it disappeared). It is distinct from TP_HIT/SL_HIT — a manual close
// is not a signal hitting its target — so it is excluded from signal win-rate analytics.
export type OutcomeStatus = "PENDING_ENTRY" | "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED" | "CLOSED";

/** Where a tracked outcome came from. */
export type OutcomeSource = "signal" | "bybit";

export interface SignalOutcome {
  id: number;
  signalId: number;
  symbol: string;
  strategy: StrategyKind;
  direction: Direction;
  status: OutcomeStatus;
  entryPrice: number;
  sl: number;
  tp: number;
  hitPrice: number | null;
  openedAt: Date;
  closedAt: Date | null;
  expiresAt: Date;
}

/** Strategy-specific TTLs in milliseconds. */
export const ENTRY_TTL: Record<StrategyKind, number> = {
  liquidity_sweep: 1 * 60 * 60 * 1000,   // 1h to enter
  trend_pullback:  1 * 60 * 60 * 1000,   // 1h to enter
  squeeze:         30 * 60 * 1000,        // 30m to enter
  momentum:        30 * 60 * 1000,        // 30m — momentum entries should fill fast
};

// Daytrade horizon: positions resolve intraday (≤6h), flat within a session.
export const OUTCOME_TTL: Record<StrategyKind, number> = {
  liquidity_sweep: 6 * 60 * 60 * 1000,   // 6h to hit TP/SL
  trend_pullback:  6 * 60 * 60 * 1000,   // 6h to hit TP/SL
  squeeze:         6 * 60 * 60 * 1000,   // 6h to hit TP/SL
  momentum:        4 * 60 * 60 * 1000,   // 4h — momentum should resolve faster
};
