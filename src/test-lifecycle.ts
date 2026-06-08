// Offline check for the edge lifecycle — no DB, no network. Validates the
// conservative classifyEdgeState ladder, runs computeEdgeSnapshot against mock
// data, and prints the formatted update/invalidation messages.
//   pnpm test:lifecycle
import { loadRules, loadEnv } from "./config.js";
import { createCache } from "./cache.js";
import { buildMockContext } from "./data/mock.js";
import { computeEdgeSnapshot, classifyEdgeState, type EdgeOriginal } from "./lifecycle/edge.js";
import { formatSignalUpdate } from "./notify.js";
import type { EdgeSnapshot, EdgeState, SignalUpdate } from "./types.js";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch {}

let failures = 0;
function expect(label: string, got: EdgeState, want: EdgeState) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : ` (expected ${want})`}`);
}

// A healthy baseline live snapshot; helpers tweak one dimension at a time.
function snap(over: Partial<EdgeSnapshot> = {}): EdgeSnapshot {
  return {
    confidence: 85,
    setup_quality: 80,
    funding_percentile: 95,
    oi_zscore: -3.2,
    volume_percentile: 70,
    structure_intact: true,
    trend: "bullish",
    trend_aligned: true,
    regime_aligned: true,
    ...over,
  };
}

// Build an original baseline; defaults to a healthy bullish long with clean structure.
function mkOriginal(over: Partial<EdgeOriginal> = {}): EdgeOriginal {
  return { confidence: 90, funding_percentile: 96, oi_zscore: -3.4, trend: "bullish", structure_intact: true, direction: "long", ...over };
}

async function main() {
  const rules = loadRules();
  const lc = rules.lifecycle;
  const original = mkOriginal();

  console.log("── classifyEdgeState ladder ───────────────────────────────");
  expect("healthy → ACTIVE", classifyEdgeState(original, snap({ confidence: 84 }), lc).state, "ACTIVE");
  expect(
    "one regression (structure intact→broken) → EDGE_WEAKENING",
    classifyEdgeState(original, snap({ structure_intact: false }), lc).state,
    "EDGE_WEAKENING",
  );
  expect(
    "confidence drop ≥ threshold alone → EDGE_WEAKENING",
    classifyEdgeState(original, snap({ confidence: original.confidence - lc.weakening_confidence_drop }), lc).state,
    "EDGE_WEAKENING",
  );
  expect(
    "structure broken + trend REVERSED → INVALIDATED",
    classifyEdgeState(original, snap({ structure_intact: false, trend: "bearish", trend_aligned: false }), lc).state,
    "INVALIDATED",
  );
  expect(
    "critical confidence collapse alone → INVALIDATED",
    classifyEdgeState(original, snap({ confidence: lc.invalidate_confidence_floor - 5 }), lc).state,
    "INVALIDATED",
  );

  console.log("── regression-only (the false-positive bug) ───────────────");
  // Trend drifting to NEUTRAL (not reversed) is not a failure.
  expect(
    "bullish→neutral trend drift → ACTIVE (not a reversal)",
    classifyEdgeState(original, snap({ trend: "neutral", trend_aligned: false }), lc).state,
    "ACTIVE",
  );
  // Counter-trend signal (e.g. squeeze) whose original trend was never aligned.
  expect(
    "originally-neutral trend stays neutral → ACTIVE (no false 'trend lost')",
    classifyEdgeState(mkOriginal({ trend: "neutral" }), snap({ trend: "neutral", trend_aligned: false }), lc).state,
    "ACTIVE",
  );
  // Structure was already imperfect at creation; still imperfect ≠ regression.
  expect(
    "structure imperfect at origin, still imperfect → ACTIVE (no regression)",
    classifyEdgeState(mkOriginal({ structure_intact: false }), snap({ structure_intact: false }), lc).state,
    "ACTIVE",
  );
  // The exact reported case: confidence unchanged, trend neutral, structure not a regression.
  expect(
    "reported case (conf 90→90, neutral trend, no structure regression) → ACTIVE",
    classifyEdgeState(mkOriginal({ structure_intact: false }), snap({ confidence: 90, trend: "neutral", trend_aligned: false, structure_intact: false }), lc).state,
    "ACTIVE",
  );

  console.log("\n── computeEdgeSnapshot against mock (sweep) ───────────────");
  const env = loadEnv();
  // Hermetic: mock data targets the EMA/ADX fallback, so disable external AI/cache
  // (mirrors index.ts mock mode) — no network, deterministic.
  env.geminiApiKey = undefined;
  const cache = await createCache();
  const ctx = await buildMockContext("BTCUSDT", "linear", "sweep");
  const live = await computeEdgeSnapshot(ctx, "liquidity_sweep", "long", rules, cache, env);
  console.log(JSON.stringify(live, null, 2));

  console.log("\n── formatted messages ─────────────────────────────────────");
  const weakening = classifyEdgeState(original, snap({ confidence: 66 }), lc);
  const wkUpdate: SignalUpdate = {
    symbol: "SOLUSDT", direction: "short", strategy: "liquidity_sweep", edgeState: weakening.state,
    original: { confidence: 93, funding_percentile: 99, oi_zscore: -3.4 },
    live: { confidence: 78, funding_percentile: 92, oi_zscore: -2.1 },
    reasons: weakening.reasons,
  };
  console.log(formatSignalUpdate(wkUpdate));
  console.log();
  const inv = classifyEdgeState(original, snap({ confidence: 28, structure_intact: false, oi_zscore: -0.4, funding_percentile: 55 }), lc);
  const invUpdate: SignalUpdate = {
    symbol: "SOLUSDT", direction: "short", strategy: "liquidity_sweep", edgeState: inv.state,
    original: { confidence: 93, funding_percentile: 99, oi_zscore: -3.4 },
    live: { confidence: 28, funding_percentile: 55, oi_zscore: -0.4 },
    reasons: inv.reasons,
  };
  console.log(formatSignalUpdate(invUpdate));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
