// Notification engine — generic, strategy-attributed events. The engine never
// formats strategy-specific fields itself; strategies provide `reasons` and
// display `fields`, the renderer below lays them out identically for every
// strategy:
//
//   Strategy: H18                      Strategy: SMC_V2
//   LONG BTCUSDT                       SHORT ETHUSDT
//
//   Reason:                            Reason:
//   7-day breakout                     Liquidity sweep
//   30-day momentum confirmed          Bearish BOS
//
// Phase 2 adds a TelegramNotificationEngine adapter that maps publish() onto
// the existing src/notify.ts transport (send/edit, buttons, throttles).
import { logger } from "../logger.js";
import type { Side } from "./types.js";

export type NotificationKind =
  | "entry" // new position intent accepted
  | "fill" // entry zone touched
  | "exit" // position closed (any terminal status)
  | "stop_moved" // trailing ratchet
  | "position_update" // periodic/owned updates (edit-in-place candidates)
  | "info"; // anything else (engine status, vetoes worth surfacing)

export interface NotificationEvent {
  kind: NotificationKind;
  strategyId: string;
  /** Human-friendly strategy name for the header; falls back to strategyId. */
  strategyLabel?: string;
  symbol: string;
  side?: Side;
  /** One-line summary after the strategy header, e.g. "LONG BTCUSDT". */
  headline: string;
  /** Strategy-authored explanation lines (the "Reason:" block). */
  reasons: string[];
  /** Ordered label/value pairs (entry, stop, target, size, age, PnL …). */
  fields: Array<[label: string, value: string]>;
  /** Optional chart image. */
  chart?: Buffer | null;
  /** Correlate events about the same position (edit-in-place, threading). */
  positionId?: string;
}

export interface NotificationEngine {
  publish(event: NotificationEvent): Promise<void>;
}

const KIND_EMOJI: Record<NotificationKind, string> = {
  entry: "🚨",
  fill: "✅",
  exit: "🏁",
  stop_moved: "🛡",
  position_update: "ℹ️",
  info: "ℹ️",
};

/** Render an event to plain text. Strategy-agnostic by construction. */
export function formatNotification(e: NotificationEvent): string {
  const lines: string[] = [];
  lines.push(`${KIND_EMOJI[e.kind]} Strategy: ${e.strategyLabel ?? e.strategyId}`);
  lines.push(e.headline);
  if (e.reasons.length) {
    lines.push("", "Reason:", ...e.reasons);
  }
  if (e.fields.length) {
    lines.push("", ...e.fields.map(([label, value]) => `${label}: ${value}`));
  }
  return lines.join("\n");
}

/** Console implementation — default until the Telegram adapter (Phase 2). */
export class ConsoleNotificationEngine implements NotificationEngine {
  async publish(event: NotificationEvent): Promise<void> {
    logger.info(`[notify:${event.kind}]\n${formatNotification(event)}`);
  }
}

/** Fan-out to multiple sinks (e.g. console + Telegram once adapted). */
export class CompositeNotificationEngine implements NotificationEngine {
  constructor(private readonly sinks: NotificationEngine[]) {}
  async publish(event: NotificationEvent): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.publish(event);
      } catch (err) {
        logger.warn(`[notify] sink failed: ${(err as Error).message}`);
      }
    }
  }
}
