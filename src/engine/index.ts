// Strategy-agnostic execution engine — public surface.
// See MIGRATION_PLAN.md for the phased adoption; nothing here is wired into
// the live signal path yet (Phase 1: foundation only).
export type {
  Side,
  StrategyContext,
  PositionState,
  EntryIntent,
  EntryDecision,
  ExitDecision,
  AccountState,
  RiskDecision,
} from "./types.js";
export { entry, noEntry, hold } from "./types.js";

export type { Strategy } from "./strategy.js";
export { StrategyRegistry } from "./strategy.js";

export type { Position, PositionStatus, PositionStore } from "./position.js";
export { createPosition, fillPosition, isOpen, InMemoryPositionStore } from "./position.js";

export type { PositionTransition, TransitionEvent } from "./exit.js";
export { evaluateBar, applyExitDecision, evaluateTick } from "./exit.js";

export type { RiskEngine, RiskLimits } from "./risk.js";
export { fixedFractionRisk, fixedNotional, volatilityTarget, advisoryOnly } from "./risk.js";

export type { LeverageRec } from "./leverage.js";
export { recommendLeverage } from "./leverage.js";

export type { NotificationEvent, NotificationKind, NotificationEngine } from "./notify.js";
export { formatNotification, ConsoleNotificationEngine, CompositeNotificationEngine } from "./notify.js";

export { DbPositionStore } from "./store-db.js";
export { NotifierNotificationEngine } from "./telegram.js";
export type { EngineCycleDeps, EngineRuntime } from "./cycle.js";
export { runEngineCycle, createEngineRuntime } from "./cycle.js";
export type { EngineTelemetry } from "./telemetry.js";
export { telemetry, getEngineTelemetry } from "./telemetry.js";

export type { StrategyFunnel, FunnelReport, FunnelStageRow } from "./funnel.js";
export { funnel, reportFor, funnelSnapshot, renderFunnel } from "./funnel.js";
