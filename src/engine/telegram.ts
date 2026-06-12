// Adapter: NotificationEngine → the existing Notifier transport. The engine
// publishes generic strategy-attributed events; this maps them onto the
// already-built Telegram/console channel (delivery, retries, clamping, ops
// separation all stay in src/notify.ts). Engine messages are distinguishable
// by their "Strategy: <id>" header — legacy alerts never carry one.
//
// Throttling: trailing strategies ratchet the stop on many consecutive bars;
// posting each move would spam the chat. stop_moved events are rate-limited
// per position; entries, fills, and exits always go through.
import type { Notifier } from "../notify.js";
import { formatNotification, type NotificationEngine, type NotificationEvent } from "./notify.js";

const STOP_MOVE_MIN_INTERVAL_MS = 30 * 60_000;

export class NotifierNotificationEngine implements NotificationEngine {
  private readonly lastStopNotice = new Map<string, number>();

  constructor(private readonly notifier: Notifier) {}

  async publish(event: NotificationEvent): Promise<void> {
    if (event.kind === "stop_moved" && event.positionId) {
      const last = this.lastStopNotice.get(event.positionId) ?? 0;
      const now = Date.now();
      if (now - last < STOP_MOVE_MIN_INTERVAL_MS) return; // throttled (still logged by console sink)
      this.lastStopNotice.set(event.positionId, now);
    }
    if (event.kind === "exit" && event.positionId) {
      this.lastStopNotice.delete(event.positionId); // free the throttle slot
    }
    await this.notifier.sendManagement(formatNotification(event));
  }
}
