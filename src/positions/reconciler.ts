// Position reconciler — runs every 60s when read-only Bybit API keys are configured.
// Diffs the live exchange position book against the source='bybit' outcomes we track:
//   • a real position with no tracked row  → create + notify ("📍 Tracking …")
//   • a tracked row whose position is gone  → close (CLOSED) + notify with realized %.
// READ-ONLY: it never places, modifies, or closes orders. Exit is the user's action on
// the exchange; we only observe it. This is the autodetect path the user wanted instead
// of the Follow button.
import type { Db } from "../db/index.js";
import type { Notifier } from "../notify.js";
import type { Direction } from "../types.js";
import type { PriceFetcher } from "../outcome/outcome-tracker.js";
import {
  fetchPositions,
  type BybitCredentials,
  type BybitPosition,
} from "../data/bybit-private.js";
import {
  createBybitOutcome,
  fetchOpenBybitOutcomes,
  closeOutcome,
  setOutcomeNotifyRef,
} from "../db/accumulate.js";
import { formatPositionLive, formatOutcome } from "../notify.js";
import { logger } from "../logger.js";

export interface PositionReconcilerDeps {
  db: Db;
  creds: BybitCredentials;
  category: string;
  fetchPrice: PriceFetcher;
  notifier: Notifier;
}

const sideToDir = (side: BybitPosition["side"]): Direction => (side === "Buy" ? "long" : "short");
const key = (symbol: string, direction: string): string => `${symbol}:${direction}`;

export async function reconcilePositions(deps: PositionReconcilerDeps): Promise<void> {
  const { db, creds, category, fetchPrice, notifier } = deps;
  if (!db) return;

  let positions: BybitPosition[];
  try {
    positions = await fetchPositions(creds, category);
  } catch (err) {
    logger.warn(`[position] fetchPositions failed: ${(err as Error).message}`);
    return;
  }

  const tracked = await fetchOpenBybitOutcomes(db);
  const trackedByKey = new Map(tracked.map((o) => [key(o.symbol, o.direction), o]));
  const liveByKey = new Map(positions.map((p) => [key(p.symbol, sideToDir(p.side)), p]));

  // ── New positions → start tracking (one self-updating message per position) ──
  for (const p of positions) {
    const direction = sideToDir(p.side);
    if (trackedByKey.has(key(p.symbol, direction))) continue;

    const id = await createBybitOutcome(db, {
      symbol: p.symbol,
      direction,
      entryPrice: p.avgPrice,
      size: p.size,
      sl: p.stopLoss,
      tp: p.takeProfit,
    });
    if (id != null) {
      try {
        const sent = await notifier.sendPositionTracked(p, direction);
        await setOutcomeNotifyRef(db, id, sent);
      } catch (err) {
        logger.warn(`[position] tracked notification failed for ${p.symbol}: ${(err as Error).message}`);
      }
    }
  }

  // ── Still-open positions → refresh the SAME message with live PnL ────────────
  for (const o of tracked) {
    const p = liveByKey.get(key(o.symbol, o.direction));
    if (!p || o.notify_message_id == null) continue;
    try {
      await notifier.editMessage(o.notify_message_id, o.notify_is_photo, formatPositionLive(o, p.markPrice, p.unrealisedPnl));
    } catch (err) {
      logger.warn(`[position] live refresh failed for ${o.symbol}: ${(err as Error).message}`);
    }
  }

  // ── Disappeared positions → close (user exited on the exchange) ─────────────
  for (const o of tracked) {
    if (liveByKey.has(key(o.symbol, o.direction))) continue;

    const now = new Date();
    let exit = o.entry_price;
    try {
      exit = await fetchPrice(o.symbol);
    } catch (err) {
      logger.warn(`[position] exit price fetch failed for ${o.symbol}: ${(err as Error).message}`);
    }
    await closeOutcome(db, o.id, "CLOSED", exit, now, o.opened_at);
    logger.info(`[position] CLOSED #${o.id} ${o.symbol} ${o.direction} @ ${exit} (position gone)`);
    try {
      // Finalize the same message to the closed summary; fall back to a new message
      // only if we never captured the tracking message id.
      const closedText = formatOutcome(o, "CLOSED", exit, now);
      if (o.notify_message_id != null) {
        await notifier.editMessage(o.notify_message_id, o.notify_is_photo, closedText);
      } else {
        await notifier.sendOutcome(o, "CLOSED", exit, now);
      }
    } catch (err) {
      logger.warn(`[position] close notification failed for ${o.symbol}: ${(err as Error).message}`);
    }
  }
}
