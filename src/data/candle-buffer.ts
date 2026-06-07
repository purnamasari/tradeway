// Pure candle-buffer logic for the WebSocket feed. Kept dependency-free and
// side-effect-free so the merge rules can be unit-tested offline (Bybit's WS is
// not reachable from every dev environment).
//
// Bybit streams kline updates for the *currently forming* candle many times, then
// once more with `confirm:true` when it closes. We keep a rolling, oldest-first
// buffer per timeframe: the last element is the forming candle, replaced in place
// on each tick and finalised when confirmed.
import type { Candle } from "../types.js";

/** A normalized kline update parsed from a Bybit WS `kline.*` message. */
export interface KlineUpdate {
  /** Candle open time, unix seconds (Bybit sends `start` in ms). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** True on the final update for a candle (it has closed). */
  confirm: boolean;
}

/**
 * Apply a kline update to an oldest-first buffer, returning a new buffer capped
 * to `cap` elements. Rules:
 *   - update.time === last.time  → replace the last candle (forming tick or close)
 *   - update.time  >  last.time  → append (a new candle started)
 *   - update.time  <  last.time  → stale/out-of-order, ignored
 * The buffer never grows past `cap`; oldest candles fall off the front.
 */
export function applyKline(buffer: Candle[], u: KlineUpdate, cap: number): Candle[] {
  const candle: Candle = {
    time: u.time,
    open: u.open,
    high: u.high,
    low: u.low,
    close: u.close,
    volume: u.volume,
  };

  const last = buffer.at(-1);
  let next: Candle[];
  if (!last || u.time > last.time) {
    next = [...buffer, candle];
  } else if (u.time === last.time) {
    next = [...buffer.slice(0, -1), candle];
  } else {
    // Out-of-order update older than what we already have — ignore.
    return buffer;
  }

  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Largest gap (in candle intervals) between the buffer's newest candle and `nowSec`.
 * Used to decide whether a reconnect needs a full REST re-seed: if the socket was
 * down long enough that more than a couple of candles were missed, the buffer is
 * no longer trustworthy for indicators and should be refetched.
 */
export function intervalsBehind(buffer: Candle[], intervalSec: number, nowSec: number): number {
  const last = buffer.at(-1);
  if (!last) return Infinity;
  return Math.floor((nowSec - last.time) / intervalSec);
}
