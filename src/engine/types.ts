// Strategy-agnostic execution engine — shared primitives.
//
// DESIGN RULE: nothing in src/engine/ may reference a concrete strategy
// (no SMC, Donchian, momentum, BOS, FVG, …). Strategies are plug-ins that
// communicate exclusively through the types in this file. Market features
// (regime label, trend label, ATR) are fine — they describe the market, not
// a strategy.
import type { Candle, Regime, Trend } from "../types.js";

export type Side = "LONG" | "SHORT";

/**
 * Everything a strategy may look at when deciding at a bar close. The engine
 * guarantees all series end at the decision bar — there is no future data in
 * a StrategyContext by construction.
 */
export interface StrategyContext {
  symbol: string;
  /** Unix seconds of the decision moment (close of the latest 15m bar). */
  closeTime: number;
  /** Close of the decision bar. */
  price: number;
  /** Closed 15m bars, oldest-first; the last element is the decision bar. */
  candles15m: Candle[];
  /** 1h aggregation up to the decision moment (last bucket may be partial). */
  candles1h: Candle[];
  /** 1m bars when the data source provides them (fine-grained triggers). */
  candles1m?: Candle[];
  // ── Shared market classification (strategies may use or ignore) ────────────
  regime: Regime | null;
  trend: Trend | null;
  atr15: number | null;
  atr1h: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  /** Hydrated history windows and other provider extras, keyed by name.
   *  An escape hatch for strategy-specific needs the engine doesn't model. */
  extras: Record<string, unknown>;
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/** Strategy-specific position memory (persisted opaquely as JSONB).
 *  e.g. H18: { highestClose } · SMC: { sweepLevel } */
export type PositionState = Record<string, unknown>;

/**
 * A strategy's request to open a position. Horizons (entry TTL, max hold) are
 * the STRATEGY's knowledge and travel with the intent — the engine has no
 * per-strategy constants.
 */
export interface EntryIntent {
  strategyId: string;
  symbol: string;
  side: Side;
  /** Limit-style entry zone. For enter-at-market semantics use a tight band
   *  around the current price. */
  entryZone: { low: number; high: number };
  /** Initial protective stop. Mandatory — every position is born with one. */
  stopPrice: number;
  /** Optional fixed target. Null = no take-profit (trail/time/strategy exit). */
  targetPrice?: number | null;
  /** How long the entry zone remains valid (ms). */
  entryTtlMs: number;
  /** Maximum holding period after fill (ms). Null = no time stop. */
  maxHoldMs?: number | null;
  /** Human-readable, strategy-authored explanation (drives notifications). */
  reasons: string[];
  /** Initial strategy state for the position. */
  state?: PositionState;
  /** Realized volatility estimate (fraction per day), if the strategy has one.
   *  Consumed by volatility-targeting risk models; optional otherwise. */
  volatility?: number | null;
  /** Display-only extras (scores, levels) for notifications/charts. */
  meta?: Record<string, unknown>;
}

export type EntryDecision =
  | { enter: false; reason: string }
  | { enter: true; intent: EntryIntent };

export const noEntry = (reason: string): EntryDecision => ({ enter: false, reason });
export const entry = (intent: EntryIntent): EntryDecision => ({ enter: true, intent });

// ── Exit ──────────────────────────────────────────────────────────────────────

/**
 * Exit primitives the engine executes. Strategy-specific exit LOGIC (opposite
 * channel break, structure invalidation, …) lives inside the strategy's
 * evaluateExit and is reduced to one of these:
 *
 *   hold        — nothing to do; standing stop/target/time exits still apply
 *   exit        — close at market now (strategy-defined exit)
 *   move_stop   — ratchet the protective stop (engine enforces ratchet-only)
 *   set_target  — set, move, or remove (null) the fixed target
 */
export type ExitDecision =
  | { action: "hold" }
  | { action: "exit"; reason: string }
  | { action: "move_stop"; stopPrice: number; reason: string }
  | { action: "set_target"; targetPrice: number | null; reason: string };

export const hold: ExitDecision = { action: "hold" };

// ── Risk ──────────────────────────────────────────────────────────────────────

/** Minimal account snapshot a sizing model needs. */
export interface AccountState {
  /** Account equity in quote currency. */
  equity: number;
  /** Open positions count (for concurrency limits). */
  openPositions: number;
  /** Sum of open risk as a fraction of equity (for exposure limits). */
  openRiskFraction: number;
}

/** A sizing verdict. `approved: false` vetoes the entry entirely. */
export interface RiskDecision {
  approved: boolean;
  /** Position size in base units (0 when vetoed or advisory-only). */
  qty: number;
  /** Quote-currency amount at risk if the stop is hit. */
  riskAmount: number;
  model: string;
  reasons: string[];
}
