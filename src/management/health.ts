// Trade Health — one 0-100 number answering "how is this open trade doing?",
// blended from five components (weights in rules.management.health_weights):
//   structure        — is the price structure that justified the trade intact?
//   momentum         — is the move still alive? (inverse of decay findings)
//   volume           — is participation supporting the direction?
//   trend_alignment  — does the 1h trend still agree?
//   risk_protection  — how much of the trade's value is actually protected by its stop?
// Pure math; the per-minute manager feeds it fresh candles + detector results.
import type {
  Candle,
  Direction,
  SRSnapshot,
  TradeHealth,
  HealthComponents,
} from "../types.js";
import { healthBand } from "../types.js";
import type { Rules } from "../config.js";
import { ema } from "../indicators.js";
import type { DecayResult, RejectionResult } from "./detectors.js";

type ManagementCfg = Rules["management"];

export interface HealthInputs {
  direction: Direction;
  entry: number;
  /** Current stop (null/0 = none set). */
  sl: number | null;
  price: number;
  /** |entry − original SL|, for R-based protection scoring. */
  initialRisk: number | null;
  candles15m: Candle[];
  candles1h: Candle[];
  sr: SRSnapshot;
  /** Hydrated history window for the volume percentile (falls back to candles). */
  volumeHistory?: number[];
  decay: DecayResult;
  rejection: RejectionResult;
  emaFast: number; // rules.regime.ema_fast
  emaSlow: number; // rules.regime.ema_slow
}

export function scoreTradeHealth(i: HealthInputs, cfg: ManagementCfg): TradeHealth {
  const components: HealthComponents = {
    structure: scoreStructure(i),
    momentum: scoreMomentum(i),
    volume: scoreVolume(i),
    trend_alignment: scoreTrendAlignment(i),
    risk_protection: scoreRiskProtection(i),
  };

  const w = cfg.health_weights;
  const totalWeight =
    w.structure + w.momentum + w.volume + w.trend_alignment + w.risk_protection || 1;
  const total = Math.round(
    (components.structure * w.structure +
      components.momentum * w.momentum +
      components.volume * w.volume +
      components.trend_alignment * w.trend_alignment +
      components.risk_protection * w.risk_protection) /
      totalWeight,
  );

  return { total: clamp(total), band: healthBand(clamp(total)), components };
}

// ── Components ────────────────────────────────────────────────────────────────

function scoreStructure(i: HealthInputs): number {
  const c15 = i.candles15m;
  let score = 50;

  // Last 3 structure candles clean (same read as setup-quality's structure_intact).
  if (structureClean(c15.slice(-3))) score += 20;

  // Higher lows (long) / lower highs (short) across the last three 5-bar blocks.
  if (steppingWithTrade(c15.slice(-15), i.direction)) score += 15;

  // Holding the protective S/R level.
  const level = i.direction === "long" ? i.sr.support : i.sr.resistance;
  if (level) {
    const holding = i.direction === "long" ? i.price > level.price : i.price < level.price;
    score += holding ? 15 : -15;
  }

  // Breakdown: latest close beyond the prior 10 bars' protective extreme.
  if (c15.length >= 11) {
    const prior = c15.slice(-11, -1);
    const lastClose = c15.at(-1)!.close;
    const broke =
      i.direction === "long"
        ? lastClose < Math.min(...prior.map((c) => c.low))
        : lastClose > Math.max(...prior.map((c) => c.high));
    if (broke) score -= 30;
  }

  return clamp(score);
}

function scoreMomentum(i: HealthInputs): number {
  // Start near-perfect and pay for each exhaustion finding; divergence is the
  // most predictive, so it costs the most.
  let score = 90;
  const d = i.decay;
  if (d.volumeContraction) score -= 15;
  if (d.atrContraction) score -= 10;
  if (d.adxDecline) score -= 20;
  if (d.rsiDivergence) score -= 25;
  if (d.macdWeakening) score -= 20;

  // Latest 15m candle still pushing with the trade is worth a little credit.
  const last = i.candles15m.at(-1);
  if (last) {
    const pushing = i.direction === "long" ? last.close > last.open : last.close < last.open;
    if (pushing) score += 10;
  }
  return clamp(score);
}

function scoreVolume(i: HealthInputs): number {
  const c15 = i.candles15m;
  const lastVol = c15.at(-1)?.volume ?? 0;
  const window =
    i.volumeHistory && i.volumeHistory.length >= 50
      ? i.volumeHistory
      : c15.map((c) => c.volume).slice(-120);

  // Participation level (percentile of current volume)…
  const below = window.filter((v) => v <= lastVol).length;
  const pctile = window.length === 0 ? 50 : (below / window.length) * 100;

  // …weighted with directional share: how much of the recent volume traded with us.
  const recent = c15.slice(-10);
  const total = recent.reduce((s, c) => s + c.volume, 0) || 1e-9;
  const withTrade = recent.reduce((s, c) => {
    const dirMatch = i.direction === "long" ? c.close >= c.open : c.close < c.open;
    return s + (dirMatch ? c.volume : 0);
  }, 0);
  const share = (withTrade / total) * 100;

  // Rejection's volume-decline finding is a direct hit on this component.
  const declinePenalty = i.rejection.volumeDeclining ? 15 : 0;

  return clamp(Math.round(pctile * 0.5 + share * 0.5 - declinePenalty));
}

function scoreTrendAlignment(i: HealthInputs): number {
  const closes1h = i.candles1h.map((c) => c.close);
  if (closes1h.length < i.emaSlow) return 55;
  const fast = ema(closes1h, i.emaFast);
  const slow = ema(closes1h, i.emaSlow);
  const price = closes1h.at(-1)!;
  const spread = slow === 0 ? 0 : (fast - slow) / slow;

  const FLAT = 0.001; // mirrors regime.ema_spread_flat's intent
  const trendDir = spread > FLAT ? "long" : spread < -FLAT ? "short" : "neutral";

  if (trendDir === "neutral") return 55;
  if (trendDir === i.direction) {
    // Committed and aligned; price beyond the fast EMA in our direction tops it up.
    const beyondFast = i.direction === "long" ? price > fast : price < fast;
    return beyondFast ? 100 : 85;
  }
  return 15; // trend opposes the trade
}

function scoreRiskProtection(i: HealthInputs): number {
  const hasStop = i.sl != null && i.sl > 0;
  if (!hasStop) return 10;

  const sign = i.direction === "long" ? 1 : -1;
  const slVsEntry = sign * (i.sl! - i.entry); // >0 = stop beyond entry (profit locked)
  const pnl = sign * (i.price - i.entry);
  const risk = i.initialRisk != null && i.initialRisk > 0 ? i.initialRisk : Math.abs(i.entry - i.sl!);

  if (slVsEntry >= 0) {
    // Breakeven or better: 75 base + up to 25 for the share of open profit locked.
    const lockedShare = pnl > 0 ? Math.min(1, slVsEntry / pnl) : 0;
    return clamp(Math.round(75 + 25 * lockedShare));
  }

  // Stop still below entry: protection erodes as unrealized profit grows unprotected.
  const exposureR = risk > 0 ? Math.abs(slVsEntry) / risk : 1;
  const unprotectedProfitR = risk > 0 ? Math.max(0, pnl) / risk : 0;
  return clamp(Math.round(65 - 15 * Math.min(1, exposureR) - 20 * Math.min(1.5, unprotectedProfitR)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Same notion as scoring.ts's structureClean: monotonic-ish, no sharp reversal.
function structureClean(candles: Candle[]): boolean {
  if (candles.length < 2) return true;
  let up = 0;
  let down = 0;
  for (const c of candles) {
    if (c.close >= c.open) up++;
    else down++;
  }
  return up === 0 || down === 0 || Math.abs(up - down) >= candles.length - 1;
}

/** Higher lows for a long (lower highs for a short) over three 5-bar blocks. */
export function steppingWithTrade(candles: Candle[], direction: Direction): boolean {
  if (candles.length < 15) return false;
  const blocks = [candles.slice(0, 5), candles.slice(5, 10), candles.slice(10, 15)];
  const extremes = blocks.map((b) =>
    direction === "long" ? Math.min(...b.map((c) => c.low)) : Math.max(...b.map((c) => c.high)),
  );
  return direction === "long"
    ? extremes[1]! > extremes[0]! && extremes[2]! > extremes[1]!
    : extremes[1]! < extremes[0]! && extremes[2]! < extremes[1]!;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
