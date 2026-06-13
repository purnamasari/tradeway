// The plug-in contract. The engine drives every registered strategy through
// these three methods and knows nothing else about it.
import type { EntryDecision, ExitDecision, PositionState, StrategyContext } from "./types.js";
import type { Position } from "./position.js";

export interface Strategy {
  /** Stable identifier; appears in position rows, notifications, analytics. */
  id: string;

  /** Human-friendly name for notifications (e.g. "SMC Scalp"). Falls back to
   *  `id` when absent. Display-only — never used for routing. */
  label?: string;

  /** One-line style descriptor shown on the entry alert (e.g. timeframe,
   *  cadence, hold horizon). Display-only. */
  description?: string;

  /** Ordered gate pipeline (shallowest → deepest), matching the `stage` values
   *  this strategy returns on rejection. Lets the gate funnel render cumulative
   *  pass-through counts. Display/metrics only; omit for an unstaged strategy. */
  stages?: string[];

  /** Closed 15m bars of history required before evaluateEntry can decide.
   *  The cycle sizes its MarketDataProvider request from the registry max. */
  minBars: number;

  /**
   * Called once per closed bar for every symbol whose (symbol, strategyId)
   * slot is free. Returns an EntryIntent or a (logged) reason for passing.
   */
  evaluateEntry(ctx: StrategyContext): EntryDecision;

  /**
   * Called once per closed bar for every open position owned by this
   * strategy, AFTER updateState. Reduces strategy-specific exit logic to an
   * engine primitive (hold / exit / move_stop / set_target). Standing exits
   * (stop, target, deadlines) are enforced by the engine regardless.
   */
  evaluateExit(ctx: StrategyContext, position: Position): ExitDecision;

  /**
   * Called once per closed bar for every open position owned by this
   * strategy, BEFORE evaluateExit. Returns the next strategy state (e.g.
   * ratchet `highestClose`); the engine persists it opaquely and passes it
   * back on the next bar. Return `position.state` unchanged if nothing moved.
   */
  updateState(ctx: StrategyContext, position: Position): PositionState;
}

/** Plug-in point: strategies register here; the engine iterates the registry. */
export class StrategyRegistry {
  private readonly byId = new Map<string, Strategy>();

  register(strategy: Strategy): void {
    if (this.byId.has(strategy.id)) {
      throw new Error(`strategy id already registered: ${strategy.id}`);
    }
    this.byId.set(strategy.id, strategy);
  }

  get(id: string): Strategy | undefined {
    return this.byId.get(id);
  }

  all(): Strategy[] {
    return [...this.byId.values()];
  }
}
