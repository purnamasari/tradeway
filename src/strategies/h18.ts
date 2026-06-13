// H18 — production strategy plug-in. Validated reference:
//   research/validation/h18.ts (rule) + research/output/H18_validation.md
//   (+0.201R/trade net taker over 1206 trades, 2023-01..2026-05, 8 symbols,
//    PASS on all robustness criteria).
//
// PARAMETERS ARE FROZEN. Any change invalidates the validation and requires a
// new research round — do not tune here.
//
// Rule (identical to the research implementation):
//   entry  : 15m close breaks the prior 7-day Donchian channel (672 bars,
//            exclusive of the decision bar) AND the 30-day return confirms
//            (|r| ≥ 5% in the break direction) AND regime is not "ranging"
//   stop   : 2·ATR(1h) initial, chandelier trail 4·ATR(1h) anchored to the
//            extreme CLOSE since fill (trail distance FROZEN at signal time)
//   target : none (the right tail pays for the system)
//   horizon: 2h entry TTL, 14-day max hold
//
// Parity notes (why this file computes its own inputs from raw 15m candles
// instead of using the engine-provided regime/atr fields):
//   - regime: research classified from the trailing 320 bars with an ATR
//     percentile over the trailing 30d of atrSeries — the engine's shared
//     regime uses DB-hydrated percentile windows, which differ.
//   - ATR(1h): research aggregated 1h candles FROM 15m bars (partial last
//     hour included); exchange-native 1h candles differ at the boundary.
// Decisions therefore depend only on the closed 15m series the
// MarketDataProvider returns — which is exactly what the replay test replays.
import type { Candle, Regime } from "../types.js";
import type { Rules } from "../config.js";
import { classifyRegime } from "../regime/engine.js";
import { atr, atrSeries } from "../indicators.js";
import type { Strategy, StrategyContext, EntryDecision, ExitDecision, PositionState } from "../engine/index.js";
import { entry, noEntry, hold } from "../engine/index.js";
import type { Position } from "../engine/index.js";

const H = 3_600_000;
const DAY_BARS = 96; // 15m bars per day

/** Frozen canonical parameters — mirrors research H18_CANONICAL exactly. */
export const H18_PARAMS = {
  donchianBars: 7 * DAY_BARS, // 672 — prior-channel lookback
  momentumBars: 30 * DAY_BARS, // 2880 — trend-filter lookback
  momentumThreshold: 0.05, // |30d return| required
  stopAtrMult: 2, // initial SL distance ×ATR1h
  trailAtrMult: 4, // chandelier distance ×ATR1h (frozen at signal)
  entryBandAtr15: 0.2, // entry zone half-width ×ATR15
  entryTtlMs: 2 * H,
  maxHoldMs: 14 * 24 * H,
} as const;

/** Bars of closed 15m history a decision needs (momentum lookback + 1). */
export const H18_MIN_BARS = H18_PARAMS.momentumBars + 1;
/** Provider depth to request: minBars + regime/ATR convergence headroom. */
export const H18_CONTEXT_BARS = H18_MIN_BARS + 511;

interface H18State extends PositionState {
  /** Extreme close since FILL (null until the first post-fill bar) —
   *  matches the research anchor, which starts at the fill bar's close. */
  anchorClose: number | null;
  /** Chandelier distance, frozen at signal time (research semantics). */
  trailDist: number;
}

/** 1h aggregation from closed 15m bars (UTC buckets, partial hour included) —
 *  copied from the research harness so ATR(1h) matches bar-for-bar. */
function aggregate1h(c15: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of c15) {
    const bucket = c.time - (c.time % 3600);
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

export function createH18Strategy(regimeRules: Rules["regime"]): Strategy {
  return {
    id: "H18",
    label: "H18 Trend",
    description: "15m Donchian breakout + trend trail, swing cadence (multi-day)",
    minBars: H18_MIN_BARS,
    stages: ["data", "regime", "channel", "momentum"],

    evaluateEntry(ctx: StrategyContext): EntryDecision {
      const c15 = ctx.candles15m;
      if (c15.length < H18_MIN_BARS) return noEntry(`needs ${H18_MIN_BARS} closed 15m bars`, "data");

      // Regime gate — research-identical inputs (window 320, trailing-30d ATR
      // percentile from atrSeries of the available series).
      const fullAtr = atrSeries(c15, regimeRules.atr_period);
      const atrHist = fullAtr.slice(-30 * DAY_BARS).filter(Number.isFinite);
      const regime: Regime = classifyRegime(c15.slice(-320), regimeRules, atrHist).regime;
      if (regime === "ranging") return noEntry("regime ranging — breakout entries blocked", "regime");

      const atr1h = atr(aggregate1h(c15).slice(-120), 14);
      if (!Number.isFinite(atr1h) || atr1h <= 0) return noEntry("ATR(1h) unavailable", "data");
      const atr15 = fullAtr[fullAtr.length - 1]!;
      const close = c15[c15.length - 1]!.close;

      // Prior 7d channel, exclusive of the decision bar.
      const win = c15.slice(-(H18_PARAMS.donchianBars + 1), -1);
      let hi = -Infinity;
      let lo = Infinity;
      for (const c of win) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
      }
      const breakUp = close > hi;
      const breakDn = close < lo;
      if (!breakUp && !breakDn) return noEntry("no 7d channel break", "channel");

      const r = close / c15[c15.length - 1 - H18_PARAMS.momentumBars]!.close - 1;
      const state: H18State = { anchorClose: null, trailDist: H18_PARAMS.trailAtrMult * atr1h };
      const base = {
        strategyId: "H18",
        symbol: ctx.symbol,
        entryZone: { low: close - H18_PARAMS.entryBandAtr15 * atr15, high: close + H18_PARAMS.entryBandAtr15 * atr15 },
        targetPrice: null,
        entryTtlMs: H18_PARAMS.entryTtlMs,
        maxHoldMs: H18_PARAMS.maxHoldMs,
        state,
      };

      if (breakUp && r >= H18_PARAMS.momentumThreshold) {
        return entry({
          ...base,
          side: "LONG",
          stopPrice: close - H18_PARAMS.stopAtrMult * atr1h,
          reasons: [
            `7-day breakout (close ${close} > channel high ${hi})`,
            `30-day momentum confirmed (${(r * 100).toFixed(1)}%)`,
            `regime ${regime} (not ranging)`,
          ],
        });
      }
      if (breakDn && r <= -H18_PARAMS.momentumThreshold) {
        return entry({
          ...base,
          side: "SHORT",
          stopPrice: close + H18_PARAMS.stopAtrMult * atr1h,
          reasons: [
            `7-day breakdown (close ${close} < channel low ${lo})`,
            `30-day momentum confirmed (${(r * 100).toFixed(1)}%)`,
            `regime ${regime} (not ranging)`,
          ],
        });
      }
      return noEntry(
        breakUp ? `breakout without momentum (r30 ${(r * 100).toFixed(1)}% < 5%)` : `breakdown without momentum (r30 ${(r * 100).toFixed(1)}% > -5%)`,
        "momentum",
      );
    },

    updateState(ctx: StrategyContext, position: Position): PositionState {
      const s = position.state as H18State;
      const prev = s.anchorClose;
      const anchor =
        prev == null
          ? ctx.price // first post-fill bar: anchor starts at its close (research)
          : position.side === "LONG"
            ? Math.max(prev, ctx.price)
            : Math.min(prev, ctx.price);
      if (anchor === prev) return position.state;
      return { ...s, anchorClose: anchor } satisfies H18State;
    },

    evaluateExit(_ctx: StrategyContext, position: Position): ExitDecision {
      const s = position.state as H18State;
      if (s.anchorClose == null || !Number.isFinite(s.trailDist)) return hold;
      const trail =
        position.side === "LONG" ? s.anchorClose - s.trailDist : s.anchorClose + s.trailDist;
      const tightens = position.side === "LONG" ? trail > position.stopPrice : trail < position.stopPrice;
      return tightens
        ? { action: "move_stop", stopPrice: trail, reason: "chandelier trail (4·ATR1h off extreme close)" }
        : hold;
    },
  };
}
