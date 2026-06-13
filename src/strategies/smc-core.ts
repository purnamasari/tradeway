// SMC (smart-money concepts) setup detection — pure functions shared by the
// research reference (research/validation/smc.ts) and the production plug-in
// (src/strategies/smc.ts). One code path for both sides means entry parity is
// by construction; only context windowing (ATR convergence) can differ.
//
// The setup is a four-part confluence, decided at the close of bar i using
// bars ≤ i only (pivots are confirmed `pivotK` bars after they form, so a
// pivot at j is readable at i iff j ≤ i − pivotK):
//
//   1. LIQUIDITY SWEEP — a bar t in the last `sweepWindow` bars wicks through
//      an intact swing low (long case): low[t] < pivot level, close[t] back
//      above it, the level untouched since the pivot formed (first take-out),
//      and every close from t to i holds above the reclaimed level.
//   2. BREAK OF STRUCTURE — the decision bar i is the FIRST close above the
//      most recent confirmed swing high (close[i−1] was at/below it). The
//      "first close" requirement also dedupes the signal: one setup per
//      structure shift.
//   3. FAIR VALUE GAP — the displacement leg (t..i] left a 3-bar imbalance
//      (low[m+1] > high[m−1] for longs); the gap is below the current close
//      and not fully filled since. The gap is the limit-entry zone — the
//      retrace destination.
//   4. ORDER BLOCK — the last opposite-color candle between the sweep and the
//      FVG candle refines the stop: SL goes beyond min(sweep wick, OB low)
//      minus an ATR buffer.
//
// Exit plan carried by the setup: fixed TP at the nearest UNTAPPED opposing
// liquidity pool (skip if it offers < minRR; cap at maxRR; default 2R when no
// pool is in range), breakeven stop-move at +1R (close-based), time stop.
import type { Candle, Direction } from "../types.js";

const H = 3_600_000;
/** Target when no untapped opposing liquidity pool is within lookback. */
export const SMC_DEFAULT_RR = 2;

export interface SmcParams {
  pivotK: number; // bars each side that confirm a swing pivot
  liqLookbackBars: number; // how far back liquidity pools are scanned
  sweepWindow: number; // sweep bar must be within this many bars of decision
  minRR: number; // liquidity target must offer at least this reward:risk
  maxRR: number; // target capped at this many R
  slBufAtr: number; // stop buffer beyond structure, ×ATR15
  beTriggerR: number; // breakeven stop-move trigger (R, close-based); 0 = off
  /** Higher-timeframe bias: the return over this many bars must agree in sign
   *  with the trade direction (sweep = liquidity grab WITH the larger flow).
   *  0 = no bias filter. */
  biasBars: number;
  /** Entry zone = the deeper `entryFrac` of the FVG (1 = whole gap). Deeper
   *  entries fill less often but at structurally better prices. */
  entryFrac: number;
  /** Displacement quality: FVG height must be ≥ this ×ATR15. 0 = off. */
  fvgMinAtr: number;
  /** 0 = limit retrace into the FVG; 1 = market at the BOS close (±0.2·ATR15
   *  band), keeping the FVG as displacement EVIDENCE only. */
  entryStyle: number;
  entryTtlMs: number; // entry-zone validity
  maxHoldMs: number; // time stop after fill
}

/** Frozen canonical parameters (daytrader cadence on 15m bars).
 *
 *  Design protocol (mirrors H18): the rule family was designed and these
 *  values chosen on BTC+SOL only (research/validation/probe-smc.ts rounds
 *  1-5); the other six symbols stayed untouched until the validation suite.
 *  Design findings baked in: displacement quality (fvgMinAtr) is the edge's
 *  load-bearing filter; FVG-retrace limit entries beat market entries at the
 *  BOS close; breakeven stop-moves scratch eventual winners (off); deep
 *  retrace fills and long entry TTLs are adversely selected (off / 2h). */
export const SMC_CANONICAL: SmcParams = {
  pivotK: 3,
  liqLookbackBars: 192, // 2 days of 15m bars
  sweepWindow: 12, // sweep within the last 3h
  minRR: 1.5,
  maxRR: 3,
  slBufAtr: 0.25,
  beTriggerR: 0, // breakeven off — measured to scratch winners (round 2)
  biasBars: 0,
  entryFrac: 1,
  fvgMinAtr: 0.75, // displacement quality — the load-bearing filter
  entryStyle: 0, // limit retrace into the FVG
  entryTtlMs: 2 * H,
  maxHoldMs: 48 * H,
};

/** Confirmed-pivot flags for a candle series; flag[j] is set iff bar j is a
 *  strict high/low of [j−k, j+k]. Readers must additionally enforce
 *  j ≤ i − k so a pivot is only used once its right side has closed. */
export interface PivotFlags {
  hi: Uint8Array;
  lo: Uint8Array;
}

export function computePivots(candles: Candle[], k: number): PivotFlags {
  const n = candles.length;
  const hi = new Uint8Array(n);
  const lo = new Uint8Array(n);
  outer: for (let j = k; j < n - k; j++) {
    const h = candles[j]!.high;
    const l = candles[j]!.low;
    let isHi = true;
    let isLo = true;
    for (let m = j - k; m <= j + k; m++) {
      if (m === j) continue;
      if (candles[m]!.high >= h) isHi = false;
      if (candles[m]!.low <= l) isLo = false;
      if (!isHi && !isLo) continue outer;
    }
    if (isHi) hi[j] = 1;
    if (isLo) lo[j] = 1;
  }
  return { hi, lo };
}

export interface SmcSetup {
  direction: Direction;
  /** FVG entry zone (limit retrace entry). */
  zoneLow: number;
  zoneHigh: number;
  sl: number;
  tp: number;
  rr: number; // (tp − zone mid) / (zone mid − sl), signed positive
  sweptLevel: number; // raided liquidity level
  sweepExtreme: number; // raid wick extreme (stop anchor)
  bosLevel: number; // structure level broken by the decision bar
  obLevel: number | null; // order-block extreme used for stop refinement
}

// ── Stage-level rejection (observability) ─────────────────────────────────────
// The detector is otherwise a black box: every reject collapses to `null`. The
// staged variant below names WHICH gate stopped a setup, so the engine can log
// it and build a gate funnel. Trading logic is byte-for-byte unchanged — the
// staged function computes exactly what detectSide did; only the failure return
// carries a label now. `detectSmcSetup` stays a thin `.ok ? setup : null`
// wrapper so research + backtest callers are completely unaffected.
export type SmcRejectStage = "data" | "bias" | "bos" | "sweep" | "fvg" | "sanity" | "rr";

export type SmcResult =
  | { ok: true; setup: SmcSetup }
  | { ok: false; stage: SmcRejectStage; reason: string };

/** Funnel order — how far a setup progressed before it failed. Higher = deeper. */
const STAGE_RANK: Record<SmcRejectStage, number> = {
  data: 0,
  bias: 1,
  bos: 2,
  sweep: 3,
  fvg: 4,
  sanity: 5,
  rr: 6,
};

const reject = (stage: SmcRejectStage, reason: string): SmcResult => ({ ok: false, stage, reason });

/**
 * Detect an SMC setup at the close of bar i. Reads candles[0..i] only.
 * `piv` may be precomputed over the WHOLE series (research): a swept pivot is
 * provably ≤ i − k, so global flags carry no future information at i.
 *
 * Backward-compatible wrapper over {@link detectSmcSetupStaged}: identical
 * return value (`SmcSetup | null`) so existing research/backtest callers are
 * untouched.
 */
export function detectSmcSetup(
  candles: Candle[],
  i: number,
  atr15: number,
  p: SmcParams,
  piv: PivotFlags = computePivots(candles, p.pivotK),
): SmcSetup | null {
  const r = detectSmcSetupStaged(candles, i, atr15, p, piv);
  return r.ok ? r.setup : null;
}

/**
 * Stage-aware detection. Same computation as {@link detectSmcSetup}; on failure
 * returns the gate that stopped it. When both directions fail, reports the side
 * that progressed FURTHEST (the most informative explanation).
 */
export function detectSmcSetupStaged(
  candles: Candle[],
  i: number,
  atr15: number,
  p: SmcParams,
  piv: PivotFlags = computePivots(candles, p.pivotK),
): SmcResult {
  if (i < p.pivotK + 2 || !Number.isFinite(atr15) || atr15 <= 0) {
    return reject("data", "insufficient bars or ATR unavailable");
  }
  const long = detectSide(candles, i, atr15, p, piv, "long");
  if (long.ok) return long;
  const short = detectSide(candles, i, atr15, p, piv, "short");
  if (short.ok) return short;
  // Both sides failed — surface whichever reached the deeper gate.
  return STAGE_RANK[short.stage] > STAGE_RANK[long.stage] ? short : long;
}

function detectSide(
  c: Candle[],
  i: number,
  atr15: number,
  p: SmcParams,
  piv: PivotFlags,
  dir: Direction,
): SmcResult {
  const long = dir === "long";
  const k = p.pivotK;
  const lo0 = Math.max(0, i - p.liqLookbackBars);
  const close = c[i]!.close;

  // ── 0. Higher-timeframe bias gate (optional) ───────────────────────────────
  if (p.biasBars > 0) {
    if (i < p.biasBars) return reject("bias", "insufficient bars for bias window");
    const r = close / c[i - p.biasBars]!.close - 1;
    if (long ? r <= 0 : r >= 0) return reject("bias", "higher-timeframe bias disagrees with direction");
  }

  // ── 2. BOS gate first (cheapest, rarest) ──────────────────────────────────
  // Most recent confirmed opposing swing; the decision bar must be the FIRST
  // close beyond it.
  let bosLevel = NaN;
  for (let j = i - k; j >= lo0; j--) {
    if (long ? piv.hi[j] : piv.lo[j]) {
      bosLevel = long ? c[j]!.high : c[j]!.low;
      break;
    }
  }
  if (!Number.isFinite(bosLevel)) return reject("bos", "no opposing swing pivot to break");
  const broke = long ? close > bosLevel : close < bosLevel;
  const prevInside = long ? c[i - 1]!.close <= bosLevel : c[i - 1]!.close >= bosLevel;
  if (!broke || !prevInside) return reject("bos", "no fresh break of structure (not first close beyond swing)");

  // ── 1. Liquidity sweep within the last sweepWindow bars ───────────────────
  // Walk back from each candidate raid bar t tracking the running extreme;
  // intact pools are exactly the pivots that set a new extreme on that walk.
  // Take the most recent t, and at t the DEEPEST raided-and-reclaimed pool.
  let sweepT = -1;
  let sweptLevel = NaN;
  for (let t = i; t > Math.max(i - p.sweepWindow, 0) && sweepT === -1; t--) {
    const raidExtreme = long ? c[t]!.low : c[t]!.high;
    const reclaim = c[t]!.close;
    let run = long ? Infinity : -Infinity;
    for (let j = t - 1; j >= lo0; j--) {
      const lvl = long ? c[j]!.low : c[j]!.high;
      const newExtreme = long ? lvl < run : lvl > run;
      if (!newExtreme) continue;
      // Intact pool: pivot AND first take-out (nothing between j and t reached
      // it — guaranteed because lvl is a new running extreme on this walk).
      // A raided pivot is structurally ≤ t − k (the raid would have destroyed
      // a nearer pivot), hence ≤ i − k: confirmed at decision time.
      if ((long ? piv.lo[j] : piv.hi[j]) && (long ? raidExtreme < lvl && reclaim > lvl : raidExtreme > lvl && reclaim < lvl)) {
        sweptLevel = lvl; // walking back ⇒ each hit is deeper; keep the last
      }
      run = lvl;
      // Anything further back lies beyond the raid wick — cannot be a
      // raided-and-reclaimed level. Stop.
      if (long ? run <= raidExtreme : run >= raidExtreme) break;
    }
    if (Number.isFinite(sweptLevel)) sweepT = t;
  }
  if (sweepT === -1) return reject("sweep", "no liquidity sweep of an intact pool in window");

  // Reclaim must HOLD: every close from the sweep bar to the decision bar
  // stays on the reclaimed side (wicks below are re-raids and are tolerated).
  let sweepExtreme = long ? Infinity : -Infinity;
  for (let m = sweepT; m <= i; m++) {
    if (long ? c[m]!.close <= sweptLevel : c[m]!.close >= sweptLevel) {
      return reject("sweep", "sweep reclaim did not hold (close back through level)");
    }
    sweepExtreme = long ? Math.min(sweepExtreme, c[m]!.low) : Math.max(sweepExtreme, c[m]!.high);
  }

  // ── 3. Fair value gap in the displacement leg (entry zone) ────────────────
  let fvgIdx = -1;
  let zoneLow = NaN;
  let zoneHigh = NaN;
  for (let m = i - 1; m > sweepT; m--) {
    const gap = long ? c[m + 1]!.low - c[m - 1]!.high : c[m - 1]!.low - c[m + 1]!.high;
    if (gap <= 0) continue;
    const zLow = long ? c[m - 1]!.high : c[m + 1]!.high;
    const zHigh = long ? c[m + 1]!.low : c[m - 1]!.low;
    // Displacement quality: a thin gap is noise, not institutional imbalance.
    if (zHigh - zLow < p.fvgMinAtr * atr15) continue;
    // Zone must sit on the retrace side of the current close…
    if (long ? zHigh >= close : zLow <= close) continue;
    // …and must not be fully filled since it formed.
    let filled = false;
    for (let q = m + 2; q <= i; q++) {
      if (long ? c[q]!.low <= zLow : c[q]!.high >= zHigh) {
        filled = true;
        break;
      }
    }
    if (filled) continue;
    fvgIdx = m;
    zoneLow = zLow;
    zoneHigh = zHigh;
    break; // most recent unfilled gap in the leg
  }
  if (fvgIdx === -1) return reject("fvg", "no unfilled displacement gap ≥ threshold");

  // Entry zone: either the FVG itself (limit retrace) or a tight band around
  // the BOS close (market-style; the FVG remains displacement evidence).
  if (p.entryStyle === 1) {
    zoneLow = close - 0.2 * atr15;
    zoneHigh = close + 0.2 * atr15;
  } else if (p.entryFrac < 1) {
    // The deeper fraction of the gap (discount end for longs, premium for shorts).
    const depth = (zoneHigh - zoneLow) * p.entryFrac;
    if (long) zoneHigh = zoneLow + depth;
    else zoneLow = zoneHigh - depth;
  }

  // ── 4. Order block: last opposite-color candle before the displacement ────
  let obLevel: number | null = null;
  for (let q = fvgIdx - 1; q >= sweepT; q--) {
    const bearish = c[q]!.close < c[q]!.open;
    if (long ? bearish : !bearish) {
      obLevel = long ? c[q]!.low : c[q]!.high;
      break;
    }
  }

  // ── Stop / entry / target ──────────────────────────────────────────────────
  const entryMid = (zoneLow + zoneHigh) / 2;
  const stopAnchor = long
    ? Math.min(sweepExtreme, obLevel ?? Infinity)
    : Math.max(sweepExtreme, obLevel ?? -Infinity);
  const sl = long ? stopAnchor - p.slBufAtr * atr15 : stopAnchor + p.slBufAtr * atr15;
  const risk = long ? entryMid - sl : sl - entryMid;
  // Structural sanity: the stop must clear the entry zone entirely.
  if (risk <= 0 || (long ? sl >= zoneLow : sl <= zoneHigh)) {
    return reject("sanity", "stop does not clear the entry zone");
  }

  // Target: nearest UNTAPPED opposing liquidity pool beyond the current bar's
  // extreme (untapped pools form a staircase walking back, so the first one
  // found is the nearest). Seeding with the decision bar's wick counts pools
  // it already pierced as tapped.
  let tpLiq = NaN;
  let runOpp = long ? c[i]!.high : c[i]!.low;
  for (let j = i - 1; j >= lo0; j--) {
    const lvl = long ? c[j]!.high : c[j]!.low;
    const newExtreme = long ? lvl > runOpp : lvl < runOpp;
    if (newExtreme) {
      if ((long ? piv.hi[j] : piv.lo[j]) && j <= i - k) {
        tpLiq = lvl;
        break;
      }
      runOpp = lvl;
    }
  }
  let tp: number;
  let rr: number;
  if (Number.isFinite(tpLiq)) {
    rr = (long ? tpLiq - entryMid : entryMid - tpLiq) / risk;
    if (rr < p.minRR) return reject("rr", "reward:risk below minimum (pool too close)");
    rr = Math.min(rr, p.maxRR);
    tp = long ? Math.min(tpLiq, entryMid + p.maxRR * risk) : Math.max(tpLiq, entryMid - p.maxRR * risk);
  } else {
    rr = SMC_DEFAULT_RR;
    tp = long ? entryMid + SMC_DEFAULT_RR * risk : entryMid - SMC_DEFAULT_RR * risk;
  }

  return { ok: true, setup: { direction: dir, zoneLow, zoneHigh, sl, tp, rr, sweptLevel, sweepExtreme, bosLevel, obLevel } };
}
