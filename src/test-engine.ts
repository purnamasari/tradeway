// Engine foundation smoke test (pnpm test:engine).
// Drives a synthetic strategy through the full position lifecycle and asserts
// the engine invariants: fill semantics, ratchet-only trailing, pessimistic
// stop-before-target, time stops, risk sizing, and notification formatting.
// The "strategy" here is a test fixture, not a trading strategy.
import type { Candle } from "./types.js";
import {
  type Strategy,
  type StrategyContext,
  StrategyRegistry,
  createPosition,
  fillPosition,
  evaluateBar,
  applyExitDecision,
  evaluateTick,
  fixedFractionRisk,
  fixedNotional,
  volatilityTarget,
  advisoryOnly,
  formatNotification,
  InMemoryPositionStore,
  entry,
  noEntry,
  hold,
} from "./engine/index.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time, open, high, low, close, volume: 1,
});

const ctxStub: StrategyContext = {
  symbol: "TESTUSDT",
  closeTime: 1_000_000,
  price: 100,
  candles15m: [bar(999_100, 99, 101, 98, 100)],
  candles1h: [bar(996_400, 99, 101, 98, 100)],
  regime: "trending",
  trend: "bullish",
  atr15: 1,
  atr1h: 2,
  fundingRate: null,
  openInterest: null,
  extras: {},
};

// ── Fixture strategy: enters long once, trails the stop to highestClose − 4 ──
const fixture: Strategy = {
  id: "TEST_FIXTURE",
  minBars: 1,
  evaluateEntry(ctx) {
    if (ctx.price !== 100) return noEntry("fixture only enters at 100");
    return entry({
      strategyId: this.id,
      symbol: ctx.symbol,
      side: "LONG",
      entryZone: { low: 99.8, high: 100.2 },
      stopPrice: 96,
      targetPrice: null,
      entryTtlMs: 2 * 3_600_000,
      maxHoldMs: 14 * 24 * 3_600_000,
      reasons: ["synthetic breakout", "fixture momentum confirmed"],
      state: { highestClose: ctx.price },
      volatility: 0.02,
    });
  },
  updateState(ctx, position) {
    const prev = (position.state.highestClose as number) ?? ctx.price;
    return { highestClose: Math.max(prev, ctx.price) };
  },
  evaluateExit(ctx, position) {
    const trail = ((position.state.highestClose as number) ?? ctx.price) - 4;
    return trail > position.stopPrice
      ? { action: "move_stop", stopPrice: trail, reason: "trail ratchet" }
      : hold;
  },
};

async function main() {
  // ── Registry ────────────────────────────────────────────────────────────────
  const registry = new StrategyRegistry();
  registry.register(fixture);
  check("registry returns registered strategy", registry.get("TEST_FIXTURE") === fixture);
  let dupThrew = false;
  try { registry.register(fixture); } catch { dupThrew = true; }
  check("registry rejects duplicate ids", dupThrew);

  // ── Entry decision + sizing + position creation ────────────────────────────
  const decision = fixture.evaluateEntry(ctxStub);
  check("fixture decides to enter", decision.enter);
  if (!decision.enter) process.exit(1);

  const account = { equity: 10_000, openPositions: 0, openRiskFraction: 0 };
  const sized = fixedFractionRisk(0.01).size(decision.intent, account);
  check("fixed-fraction approves", sized.approved);
  check("fixed-fraction risks 1% of equity", Math.abs(sized.riskAmount - 100) < 1e-9);
  check("fixed-fraction qty = risk/stopDist", Math.abs(sized.qty - 100 / 4) < 1e-9);

  check("fixed-notional sizes by entry price", Math.abs(fixedNotional(500).size(decision.intent, account).qty - 5) < 1e-9);
  check("vol-target uses intent volatility", volatilityTarget(0.01).size(decision.intent, account).approved);
  check(
    "vol-target vetoes without volatility",
    !volatilityTarget(0.01).size({ ...decision.intent, volatility: null }, account).approved,
  );
  check("advisory approves at qty 0", advisoryOnly().size(decision.intent, account).qty === 0);
  check(
    "limits veto on max positions",
    !fixedFractionRisk(0.01, { maxOpenPositions: 1 }).size(decision.intent, { ...account, openPositions: 1 }).approved,
  );

  const store = new InMemoryPositionStore();
  let pos = createPosition(decision.intent, sized, ctxStub.closeTime * 1000, store.nextId());
  pos = await store.insert(pos);
  check("position starts PENDING_ENTRY", pos.status === "PENDING_ENTRY");
  check("slot lookup finds it", (await store.getOpenBySlot("TESTUSDT", "TEST_FIXTURE")) !== null);
  check("other strategy's slot is free", (await store.getOpenBySlot("TESTUSDT", "OTHER")) === null);

  // ── Fill on zone touch, then trail ratchet ─────────────────────────────────
  let t = evaluateBar(pos, bar(1_000_000, 100.5, 101, 100.1, 100.9), 1_000_900_000);
  check("entry zone touch fills", t.position.status === "OPEN" && t.events[0]?.kind === "filled");
  pos = t.position;

  pos = { ...pos, state: fixture.updateState({ ...ctxStub, price: 105 }, pos) };
  t = applyExitDecision(pos, fixture.evaluateExit({ ...ctxStub, price: 105 }, pos), 105, 1_001_800_000);
  check("trail ratchets stop up (96 → 101)", t.position.stopPrice === 101 && t.events[0]?.kind === "stop_moved");
  pos = t.position;

  const loosen = applyExitDecision(pos, { action: "move_stop", stopPrice: 90, reason: "bug" }, 105, 0);
  check("ratchet-only: loosening move_stop ignored", loosen.position.stopPrice === 101 && loosen.events.length === 0);

  // ── Pessimistic ordering: bar spans stop AND a target → stop wins ──────────
  const withTarget = applyExitDecision(pos, { action: "set_target", targetPrice: 106, reason: "test" }, 105, 0).position;
  const span = evaluateBar(withTarget, bar(1_002_000, 105, 107, 100, 106), 1_002_900_000);
  check("stop checked before target on a spanning bar", span.position.status === "EXITED_STOP");

  // ── Tick safety + time stop + strategy exit ────────────────────────────────
  check("tick breach exits at stop", evaluateTick(pos, 100.9, 0).position.status === "EXITED_STOP");
  const aged = { ...pos, maxHoldUntil: 1_002_000_000 };
  check(
    "max-hold closes as EXITED_TIME",
    evaluateBar(aged, bar(1_002_000, 102, 103, 102, 102.5), 1_002_900_000).position.status === "EXITED_TIME",
  );
  check(
    "strategy exit closes as EXITED_STRATEGY",
    applyExitDecision(pos, { action: "exit", reason: "thesis done" }, 104, 0).position.status === "EXITED_STRATEGY",
  );
  const stale = createPosition(decision.intent, sized, 0, store.nextId());
  check(
    "entry deadline cancels unfilled position",
    evaluateBar(stale, bar(1_002_000, 200, 201, 199, 200), stale.entryDeadline + 1).position.status === "CANCELLED",
  );
  check(
    "fillPosition arms max hold from fill time",
    fillPosition(stale, 100, 5_000).maxHoldUntil === 5_000 + 14 * 24 * 3_600_000,
  );

  // ── DB row mapping round-trip (pure mappers; no DB connection) ─────────────
  const { rowToPosition, positionToRow, statusToRow, statusFromRow } = await import("./engine/store-db.js");
  const filledPos = fillPosition({ ...pos, id: "42" }, 100.2, 1_000_900_000);
  const row = positionToRow(filledPos);
  check("row mapping: OPEN → ACTIVE", row.status === "ACTIVE");
  check("row mapping: null target → tp 0 sentinel", row.tp === 0);
  check("row mapping: expires_at = maxHoldUntil after fill", (row.expires_at as Date).getTime() === filledPos.maxHoldUntil);
  const restored = rowToPosition({
    ...(row as object),
    id: 42,
    hit_price: null,
    strategy_state: filledPos.state,
    entry_reasons: filledPos.reasons,
  } as never);
  check(
    "row round-trip preserves position",
    restored.status === "OPEN" &&
      restored.stopPrice === filledPos.stopPrice &&
      restored.targetPrice === null &&
      restored.maxHoldUntil === filledPos.maxHoldUntil &&
      (restored.state.highestClose as number) === (filledPos.state.highestClose as number) &&
      restored.reasons.length === 2,
  );
  check("status map: CANCELLED → EXPIRED + no activation", statusToRow("CANCELLED") === "EXPIRED" &&
    statusFromRow({ status: "EXPIRED", activated_at: null }) === "CANCELLED");
  check("status map: EXPIRED + activation → EXITED_TIME",
    statusFromRow({ status: "EXPIRED", activated_at: new Date() }) === "EXITED_TIME");

  // ── Notification formatting (generic, strategy-attributed) ────────────────
  const text = formatNotification({
    kind: "entry",
    strategyId: "H18",
    symbol: "BTCUSDT",
    side: "LONG",
    headline: "LONG BTCUSDT",
    reasons: ["7-day breakout", "30-day momentum confirmed"],
    fields: [["Entry", "100.00"], ["Stop", "96.00"]],
  });
  check("notification carries strategy header", text.includes("Strategy: H18") && text.includes("LONG BTCUSDT"));
  check("notification carries reason block", text.includes("Reason:\n7-day breakout\n30-day momentum confirmed"));

  console.log(failures === 0 ? "\nAll engine foundation checks passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
