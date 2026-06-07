// Two independent scores per signal:
//   confidence    — market conditions (funding/OI/volume/regime alignment)
//   setup_quality — technical structure (S/R strength, pattern, HTF, sweep, structure)
import type { Candle, MarketContext, RegimeResult, ScoreBreakdown, SRLevel } from "./types.js";
import type { Rules } from "./config.js";
import { percentileRank, zScore } from "./indicators.js";

export interface ConfidenceInput {
  ctx: MarketContext;
  regime: RegimeResult;
  regimeAligned: boolean; // strategy permitted by regime
}

export function scoreConfidence(
  input: ConfidenceInput,
  weights: Rules["confidence_weights"],
): { confidence: number; parts: Pick<ScoreBreakdown, "funding_percentile" | "oi_zscore" | "volume_percentile" | "regime_alignment"> } {
  const { ctx, regimeAligned } = input;

  // Funding: extreme (very low or very high) funding is informative. Score by
  // distance from the median of the 90d window.
  let fundingPct = 50;
  if (ctx.fundingRate !== null && ctx.fundingHistory.length > 5) {
    fundingPct = percentileRank(ctx.fundingRate, ctx.fundingHistory);
  }
  const fundingExtremity = Math.abs(fundingPct - 50) / 50; // 0..1
  const fundingScore = fundingExtremity * weights.funding_percentile;

  // OI z-score: large positioning changes => stronger signal.
  let oiZ = 0;
  if (ctx.openInterest !== null && ctx.oiHistory.length > 5) {
    oiZ = zScore(ctx.openInterest, ctx.oiHistory);
  }
  const oiScore = Math.min(1, Math.abs(oiZ) / 3) * weights.oi_zscore;

  // Volume percentile of latest 15m candle vs its recent window.
  const vols = ctx.candles15m.map((c) => c.volume);
  const lastVol = vols.at(-1) ?? 0;
  const volPct = percentileRank(lastVol, vols.slice(-120));
  const volScore = (volPct / 100) * weights.volume_percentile;

  const regimeScore = regimeAligned ? weights.regime_alignment : 0;

  const confidence = Math.round(
    Math.min(100, fundingScore + oiScore + volScore + regimeScore),
  );

  return {
    confidence,
    parts: {
      funding_percentile: round(fundingPct),
      oi_zscore: round(oiZ, 2),
      volume_percentile: round(volPct),
      regime_alignment: regimeScore,
    },
  };
}

export interface SetupQualityInput {
  srLevel: SRLevel | null;
  triggerCandle: Candle;
  prevCandle: Candle;
  htfAligned: boolean;
  sweepWickRatio?: number; // liquidity_sweep only
  candles15m: Candle[];
}

export function scoreSetupQuality(
  input: SetupQualityInput,
  weights: Rules["setup_quality_weights"],
): { setup_quality: number; parts: Pick<ScoreBreakdown, "sr_level_strength" | "engulf_body_ratio" | "htf_aligned" | "sweep_wick_ratio" | "structure_intact"> } {
  // S/R level strength (0-100) scaled to its weight.
  const srStrength = input.srLevel?.strength ?? 0;
  const srScore = (srStrength / 100) * weights.sr_level_strength;

  // Engulfing body ratio: current body vs previous body, capped at 1.0.
  const curBody = Math.abs(input.triggerCandle.close - input.triggerCandle.open);
  const prevBody = Math.abs(input.prevCandle.close - input.prevCandle.open) || 1e-9;
  const engulfRatio = curBody / prevBody;
  const engulfScore = Math.min(1, engulfRatio) * weights.engulf_body_ratio;

  // HTF alignment: boolean.
  const htfScore = input.htfAligned ? weights.htf_aligned : 0;

  // Sweep wick ratio: wick vs body, capped at 3.0, scaled.
  let sweepScore = 0;
  if (input.sweepWickRatio !== undefined) {
    sweepScore = (Math.min(3, input.sweepWickRatio) / 3) * weights.sweep_wick_ratio;
  }

  // Structure intact: no close violations across the last 3 15m candles.
  const last3 = input.candles15m.slice(-3);
  const structureIntact = structureClean(last3);
  const structureScore = structureIntact ? weights.structure_intact : 0;

  const setup_quality = Math.round(
    Math.min(100, srScore + engulfScore + htfScore + sweepScore + structureScore),
  );

  return {
    setup_quality,
    parts: {
      sr_level_strength: srStrength,
      engulf_body_ratio: round(engulfRatio, 2),
      htf_aligned: input.htfAligned,
      sweep_wick_ratio: input.sweepWickRatio !== undefined ? round(input.sweepWickRatio, 2) : undefined,
      structure_intact: structureIntact,
    },
  };
}

// "Clean" = monotonic-ish, no sharp reversal close in the window.
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

function round(n: number, dp = 0): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
