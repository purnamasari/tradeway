// Outcome evaluator. Polls open outcomes every minute and transitions them
// through the lifecycle: PENDING_ENTRY → ACTIVE → TP_HIT | SL_HIT | EXPIRED.
//
// Price source is pluggable (fetchTicker for live, injectable for testing).
import type { Db } from "../db/index.js";
import type { Notifier } from "../notify.js";
import type { StrategyKind, OutcomeStatus } from "../types.js";
import { OUTCOME_TTL } from "../types.js";
import {
  fetchOpenOutcomes,
  activateOutcome,
  closeOutcome,
  type OutcomeRow,
} from "../db/accumulate.js";
import { logger } from "../logger.js";

// ── Price source ────────────────────────────────────────────────────────────

export type PriceFetcher = (symbol: string) => Promise<number>;

// ── Evaluator ───────────────────────────────────────────────────────────────

export async function evaluateOutcomes(
  db: Db,
  fetchPrice: PriceFetcher,
  notifier: Notifier,
): Promise<void> {
  if (!db) return;

  const outcomes = await fetchOpenOutcomes(db);
  if (outcomes.length === 0) return;

  // Batch price lookups — one per unique symbol.
  const symbols = [...new Set(outcomes.map((o) => o.symbol))];
  const prices = new Map<string, number>();
  for (const sym of symbols) {
    try {
      prices.set(sym, await fetchPrice(sym));
    } catch (err) {
      logger.warn(`[outcome] Price fetch failed for ${sym}: ${(err as Error).message}`);
    }
  }

  const now = new Date();
  let evaluated = 0;

  for (const outcome of outcomes) {
    const price = prices.get(outcome.symbol);
    if (price === undefined) continue; // skip if price unavailable

    const result = evaluateSingle(outcome, price, now);
    if (!result) continue;

    evaluated++;

    if (result.action === "activate") {
      // PENDING_ENTRY → ACTIVE: price entered the entry zone
      const outcomeTtl = OUTCOME_TTL[outcome.strategy as StrategyKind] ?? 4 * 60 * 60 * 1000;
      const newExpiry = new Date(now.getTime() + outcomeTtl);
      await activateOutcome(db, outcome.id, now, newExpiry);
      logger.info(
        `[outcome] ACTIVATED #${outcome.id} ${outcome.symbol} ${outcome.direction} ${outcome.strategy} at ${price}`,
      );
    } else {
      // Terminal state: TP_HIT, SL_HIT, or EXPIRED. Pass opened_at so the close
      // records duration_ms for future analytics.
      await closeOutcome(db, outcome.id, result.status, result.hitPrice, now, outcome.opened_at);
      logger.info(
        `[outcome] ${result.status}${outcome.followed ? "" : " (shadow)"} #${outcome.id} ${outcome.symbol} ${outcome.direction} ${outcome.strategy}` +
          (result.hitPrice !== null ? ` at ${result.hitPrice}` : ""),
      );
      // Shadow outcomes (Skipped signals) close silently — they exist only for
      // counterfactual data, not to notify the user.
      if (outcome.followed) {
        try {
          await notifier.sendOutcome(outcome, result.status, result.hitPrice, now);
        } catch (err) {
          logger.warn(`[outcome] Notification failed for #${outcome.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (evaluated > 0) {
    logger.info(`[outcome] Evaluated ${evaluated}/${outcomes.length} outcomes`);
  }
}

// ── Single outcome evaluation ───────────────────────────────────────────────

interface EvalResult {
  action: "activate" | "close";
  status: "TP_HIT" | "SL_HIT" | "EXPIRED";
  hitPrice: number | null;
}

function evaluateSingle(
  outcome: OutcomeRow,
  price: number,
  now: Date,
): EvalResult | null {
  const isLong = outcome.direction === "long";
  const expired = now >= new Date(outcome.expires_at);

  if (outcome.status === "PENDING_ENTRY") {
    // Check if price has entered the entry zone
    const inZone = price >= outcome.entry_low && price <= outcome.entry_high;
    if (inZone) {
      return { action: "activate", status: "TP_HIT", hitPrice: null }; // status unused for activate
    }
    // Entry window expired — never entered
    if (expired) {
      return { action: "close", status: "EXPIRED", hitPrice: null };
    }
    return null; // still waiting
  }

  // status === "ACTIVE" — check TP/SL/expiry

  // TP hit
  if (isLong && price >= outcome.tp) {
    return { action: "close", status: "TP_HIT", hitPrice: price };
  }
  if (!isLong && price <= outcome.tp) {
    return { action: "close", status: "TP_HIT", hitPrice: price };
  }

  // SL hit
  if (isLong && price <= outcome.sl) {
    return { action: "close", status: "SL_HIT", hitPrice: price };
  }
  if (!isLong && price >= outcome.sl) {
    return { action: "close", status: "SL_HIT", hitPrice: price };
  }

  // Expired without hitting either level
  if (expired) {
    return { action: "close", status: "EXPIRED", hitPrice: price };
  }

  return null; // still active, no trigger
}
