// Offline check for the trade-management layer — no DB, no network. Exercises
// the detectors (rejection / momentum decay / liquidity events), adaptive stop
// suggestions, trade health scoring, path probabilities, plan generation, and a
// full end-to-end assessTrade pass on crafted candles, then prints the formatted
// alert/report messages for eyeballing.
//   pnpm test:management
import { loadRules } from "./config.js";
import type { Candle, Direction, MarketContext, Signal, SRSnapshot } from "./types.js";
import { detectRejection, detectMomentumDecay, detectLiquidityEvent, rsiDivergence } from "./management/detectors.js";
import { suggestStop } from "./management/stops.js";
import { estimatePaths } from "./management/paths.js";
import { buildManagementPlan } from "./management/plan.js";
import { assessTrade, type ManagedTrade } from "./management/assess.js";
import { buildSR } from "./strategy/sr-engine.js";
import {
  formatAlert,
  formatManagementEvent,
  formatTradeReport,
  formatTradeView,
  formatRecentRoot,
  formatRecentList,
  formatRecentTrade,
  formatRecentPerformance,
  coinName,
  splitCaption,
  clampMessage,
  TG_CAPTION_LIMIT,
  createNotifier,
} from "./notify.js";
import type { OutcomeRow } from "./db/accumulate.js";
import { loadWatchlist, loadEnv } from "./config.js";
import { createCache } from "./cache.js";
import { scanSymbol, normalizeSymbol, type ScannerDeps } from "./scanner.js";
import { matchSymbol } from "./data/symbols.js";
import { buildMockContext } from "./data/mock.js";

let failures = 0;
function expect(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── Candle builders ───────────────────────────────────────────────────────────

let T = 1_700_000_000;
function candle(open: number, close: number, high: number, low: number, volume: number): Candle {
  T += 60;
  return { time: T, open, close, high, low, volume };
}

/** Clean staircase uptrend with periodic pullbacks (forms swing lows). */
function uptrend(n: number, start = 100): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const dip = i % 8 === 4;
    const close = dip ? p - 0.6 : p + 0.5;
    out.push(candle(p, close, Math.max(p, close) + 0.2, Math.min(p, close) - 0.2, 800 + i * 10));
    p = close;
  }
  return out;
}

/** Steady downtrend (for an opposed 1h bias). */
function downtrend(n: number, start = 130): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const close = p - 0.5;
    out.push(candle(p, close, p + 0.2, close - 0.2, 800));
    p = close;
  }
  return out;
}

/** Rally that rolls over: wide-range/high-volume start, tight/quiet drift end. */
function exhaustedRally(n = 50, start = 100): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const vol = Math.max(50, 1500 - 25 * i);
    if (i < 30) {
      const close = p + 0.8;
      out.push(candle(p, close, close + 1.1, p - 1.1, vol));
      p = close;
    } else {
      const close = p - 0.2;
      out.push(candle(p, close, p + 0.15, close - 0.15, vol));
      p = close;
    }
  }
  return out;
}

/** 1m series ending in repeated upper-wick rejections with fading buy volume. */
function rejecting1m(n = 30, around = 120): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n - 10; i++) {
    out.push(candle(around - 0.2, around + 0.2, around + 0.25, around - 0.25, 1000));
  }
  for (let i = 0; i < 10; i++) {
    const vol = i < 5 ? 1000 : 300; // buy volume collapses in the second half
    out.push(candle(around, around + 0.1, around + 0.55, around - 0.05, vol));
  }
  return out;
}

function mkCtx(c1m: Candle[], c15m: Candle[], c1h: Candle[]): MarketContext {
  return {
    symbol: "ZECUSDT",
    candles1m: c1m,
    candles15m: c15m,
    candles1h: c1h,
    fundingRate: null,
    openInterest: null,
    fundingHistory: [],
    oiHistory: [],
    historyConfidence: 0,
  };
}

const SR_AT_RESISTANCE: SRSnapshot = {
  support: { price: 118.5, kind: "support", touches: 3, strength: 60 },
  resistance: { price: 120.5, kind: "resistance", touches: 4, strength: 80 },
  levels: [],
};

async function main() {
  const rules = loadRules();
  const m = rules.management;

  console.log("── rejection detection ────────────────────────────────────");
  const rej = detectRejection(rejecting1m(), "long", SR_AT_RESISTANCE, m);
  expect("rejection wicks counted", rej.wickCount >= m.rejection_wicks_min, `${rej.wickCount} wicks`);
  expect("buy volume decline detected", rej.volumeDeclining);
  expect("overall rejection risk", rej.risk, rej.signals.join("; "));
  const clean = detectRejection(uptrend(30).slice(-30), "long", SR_AT_RESISTANCE, m);
  expect("clean uptrend → no rejection risk", !clean.risk);

  console.log("\n── momentum decay ─────────────────────────────────────────");
  const decay = detectMomentumDecay(exhaustedRally(), "long", m);
  expect("volume contraction", decay.volumeContraction);
  expect("ATR contraction", decay.atrContraction);
  expect("overall momentum fading", decay.fading, decay.signals.join("; "));
  const strong = detectMomentumDecay(uptrend(60), "long", m);
  expect("steady uptrend → not fading", !strong.fading, strong.signals.join("; "));

  console.log("\n── RSI divergence ─────────────────────────────────────────");
  // First half: vertical rally (RSI pinned high). Second half: grinding higher
  // highs on shallow net progress (RSI cools) => bearish divergence for a long.
  const div: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 15; i++) {
    const close = p + 1;
    div.push(candle(p, close, close + 0.2, p - 0.1, 500));
    p = close;
  }
  for (let i = 0; i < 15; i++) {
    const close = i % 2 === 0 ? p + 0.3 : p - 0.1;
    div.push(candle(p, close, Math.max(p, close) + 0.2, Math.min(p, close) - 0.1, 500));
    p = close;
  }
  expect("higher high on cooling RSI → divergence", rsiDivergence(div, "long"));
  expect("steady trend → no divergence", !rsiDivergence(uptrend(30), "long"));

  console.log("\n── liquidity events ───────────────────────────────────────");
  const sweep: Candle[] = [];
  for (let i = 0; i < 17; i++) sweep.push(candle(99.8, 100.2, 100.5, 99.6, 100));
  sweep.push(candle(100.2, 100.2, 101.0, 100.0, 250)); // sweeps 100.5, closes 100.2
  sweep.push(candle(100.2, 100.1, 100.3, 100.0, 100));
  sweep.push(candle(100.1, 100.0, 100.2, 99.9, 100));
  const liq = detectLiquidityEvent(sweep, "long", m);
  expect("sweep above highs → breakout trap (against long)", liq.event === "breakout_trap" && liq.bias === "against", liq.detail.join("; "));
  const calm = detectLiquidityEvent(uptrend(30), "long", m);
  expect("clean trend → no liquidity event", calm.event === null);

  console.log("\n── adaptive stop suggestion ───────────────────────────────");
  const trendCandles = uptrend(60);
  const lastPrice = trendCandles.at(-1)!.close;
  const sr = buildSR(trendCandles, lastPrice);
  const stop = suggestStop(
    {
      direction: "long", entry: 110, currentSl: 105, price: lastPrice,
      candles15m: trendCandles, sr, regime: "trending", initialRisk: 5,
    },
    m,
  );
  expect("uptrend suggests a better stop", stop !== null, stop ? `${stop.price} via ${stop.method}` : "null");
  if (stop) {
    expect("suggested stop above old stop", stop.price > 105, `${stop.price}`);
    expect("suggested stop below price", stop.price < lastPrice);
    expect("trending regime → swing method", stop.method === "swing", stop.method);
  }
  const noStop = suggestStop(
    {
      direction: "long", entry: 110, currentSl: null, price: lastPrice,
      candles15m: trendCandles, sr, regime: "high_volatility", initialRisk: null,
    },
    m,
  );
  expect("position without a stop gets one suggested", noStop !== null, noStop ? noStop.reasons.join("; ") : "");

  console.log("\n── path probabilities ─────────────────────────────────────");
  const base = { direction: "long" as Direction, price: 449.08, entry: 449.08, sl: 435.75, tp: 482.39 };
  const pStrong = estimatePaths({ ...base, strength: 0.74, strategy: "momentum", volumePercentile: 100 })!;
  const pWeak = estimatePaths({ ...base, strength: 0.35, strategy: "liquidity_sweep" })!;
  expect("paths sum to 100 (strong)", pStrong.tp_direct + pStrong.retest_then_tp + pStrong.sl_hit === 100, JSON.stringify(pStrong));
  expect("paths sum to 100 (weak)", pWeak.tp_direct + pWeak.retest_then_tp + pWeak.sl_hit === 100, JSON.stringify(pWeak));
  expect("stronger setup → lower SL probability", pStrong.sl_hit < pWeak.sl_hit, `${pStrong.sl_hit}% vs ${pWeak.sl_hit}%`);
  expect("momentum strategy → more direct-TP weight", pStrong.tp_direct > pWeak.tp_direct);
  expect("no-SL position → paths unavailable", estimatePaths({ ...base, sl: 0, strength: 0.5 }) === null);

  console.log("\n── management plan ────────────────────────────────────────");
  const signal: Signal = {
    symbol: "ZECUSDT", strategy: "momentum", direction: "long",
    entry_low: 448.6309, entry_high: 449.5291, sl: 435.7547, tp: 482.3933, rr: 2.5,
    confidence: 81, setup_quality: 64,
    score_breakdown: {
      funding_percentile: 50, oi_zscore: 0, volume_percentile: 100, regime_alignment: 10,
      sr_level_strength: 0, engulf_body_ratio: 2.72, htf_aligned: false, structure_intact: true,
    },
    regime: "high_volatility", trend: "neutral", trend_source: "ema_adx_fallback",
    snapshot: { price: 449.08, support: null, resistance: null, funding_rate: null, open_interest: null },
    detected_at: Date.now(),
  };
  const plan = buildManagementPlan(signal, rules);
  expect("high_volatility regime → ATR trailing", plan.trail_method === "atr");
  expect("protection includes breakeven rule", plan.protection.some((r) => r.action.includes("breakeven")));
  expect("emergency has structure-break rule", plan.emergency.some((r) => r.trigger.includes("structure")));
  signal.plan = plan;
  signal.paths = estimatePaths({
    ...base, strength: (signal.confidence * 0.6 + signal.setup_quality * 0.4) / 100,
    strategy: "momentum", volumePercentile: 100,
  })!;

  console.log("\n── end-to-end assessTrade: healthy long ───────────────────");
  const healthyCtx = mkCtx(
    uptrend(30, 140).map((c) => ({ ...c, volume: 900 })),
    uptrend(80),
    uptrend(60, 80),
  );
  const healthyTrade: ManagedTrade = {
    symbol: "ZECUSDT", direction: "long", strategy: "momentum", source: "signal",
    entryPrice: healthyCtx.candles1m.at(-1)!.close - 3,
    sl: healthyCtx.candles1m.at(-1)!.close - 6, tp: healthyCtx.candles1m.at(-1)!.close + 9,
    initialRisk: 3, entryConfidence: 81, currentConfidence: 78, edgeState: "ACTIVE",
  };
  const healthy = assessTrade(healthyTrade, healthyCtx, rules);
  expect("healthy trade scores ≥ 55", healthy.health.total >= 55, `${healthy.health.total} (${healthy.health.band})`);
  expect("healthy trade has no critical events", healthy.events.every((e) => e.severity !== "critical"));
  expect("in-profit trade computes +R", healthy.pnlR != null && healthy.pnlR > 0, `+${healthy.pnlR}R`);
  expect("live paths available", healthy.paths !== null, JSON.stringify(healthy.paths));

  console.log("\n── end-to-end assessTrade: deteriorating long, no stop ────");
  const sickCtx = mkCtx(rejecting1m(), exhaustedRally(), downtrend(60));
  const sickTrade: ManagedTrade = {
    symbol: "ZECUSDT", direction: "long", strategy: "manual", source: "bybit",
    entryPrice: 121, sl: null, tp: null, initialRisk: null,
    entryConfidence: null, currentConfidence: null, edgeState: "ACTIVE",
  };
  const sick = assessTrade(sickTrade, sickCtx, rules);
  expect("deteriorating trade scores < 55", sick.health.total < 55, `${sick.health.total} (${sick.health.band})`);
  expect("warns about the missing stop", sick.warnings.some((w) => w.includes("stop-loss")));
  expect("suggests setting a stop", sick.actions.some((a) => a.toLowerCase().includes("stop")), sick.actions[0] ?? "");
  const kinds = sick.events.map((e) => e.kind);
  expect("emits rejection event", kinds.includes("rejection_risk"), kinds.join(", "));
  expect("emits momentum-decay event", kinds.includes("momentum_decay"));

  console.log("\n── telegram caption limits ────────────────────────────────");
  const alertText = formatAlert(signal);
  const [caption, overflow] = splitCaption(alertText);
  expect("caption fits the photo limit", caption.length <= TG_CAPTION_LIMIT, `${caption.length} chars`);
  if (alertText.length > TG_CAPTION_LIMIT) {
    expect("overflow carries the management plan", overflow !== null && overflow.startsWith("Management plan:"));
  } else {
    expect("short alert passes through unsplit", overflow === null);
  }
  const [shortCap, noOverflow] = splitCaption("short message");
  expect("short caption untouched", shortCap === "short message" && noOverflow === null);
  expect(
    "oversized caption clamps with ellipsis",
    clampMessage("x".repeat(2000), true).length === TG_CAPTION_LIMIT,
  );

  console.log("\n── ticker normalization ───────────────────────────────────");
  expect("zec → ZECUSDT", normalizeSymbol("zec") === "ZECUSDT");
  expect("' btc ' → BTCUSDT", normalizeSymbol(" btc ") === "BTCUSDT");
  expect("wld → WLDUSDT", normalizeSymbol("wld") === "WLDUSDT");
  expect("btc-usdt → BTCUSDT", normalizeSymbol("btc-usdt") === "BTCUSDT");
  expect("ZECUSDT passes through", normalizeSymbol("ZECUSDT") === "ZECUSDT");
  expect("BTCUSD (inverse) untouched", normalizeSymbol("BTCUSD") === "BTCUSD");
  expect("empty stays empty", normalizeSymbol("  ") === "");

  console.log("\n── symbol resolution (instrument matching) ────────────────");
  const instruments = new Set(["BTCUSDT", "ETHUSDT", "ZECUSDT", "WLDUSDT", "SOLUSDC", "BTCPERP"]);
  const hit = matchSymbol("zec", instruments);
  expect("zec matches ZECUSDT", hit.ok && hit.symbol === "ZECUSDT");
  const exact = matchSymbol("btcusdt", instruments);
  expect("exact symbol matches", exact.ok && exact.symbol === "BTCUSDT");
  const usdc = matchSymbol("sol", instruments);
  expect("falls through quote suffixes", usdc.ok && usdc.symbol === "SOLUSDC");
  const miss = matchSymbol("zwc", instruments);
  expect("unknown coin rejected", !miss.ok);
  const typo = matchSymbol("WL", instruments);
  expect(
    "typo offers suggestions",
    !typo.ok && !typo.ok === true && typo.error.includes("WLDUSDT"),
    !typo.ok ? typo.error : "",
  );
  const blank = matchSymbol("  ", instruments);
  expect("blank input rejected", !blank.ok);

  console.log("\n── manual scan briefing (mock pipeline) ───────────────────");
  const env = loadEnv();
  env.geminiApiKey = undefined;
  env.telegramBotToken = undefined;
  env.databaseUrl = undefined;
  const watchlist = loadWatchlist();
  const scanDeps: ScannerDeps = {
    cache: await createCache(),
    db: null,
    notifier: await createNotifier(env),
    rules,
    global: watchlist.global,
    env,
    getContext: (symbol, category) => buildMockContext(symbol, category, "sweep"),
  };
  const briefingReply = await scanSymbol(
    { symbol: "BTCUSDT", enabled: true, scan_interval: 0, asset_class: "manual" },
    scanDeps,
    { manual: true },
  );
  const briefing = briefingReply.text;
  expect("briefing shows market read", briefing.includes("Regime:") && briefing.includes("Trend 1h:"));
  expect("briefing lists detector verdicts", briefing.includes("Detectors:"));
  expect("briefing ends with a verdict", briefing.includes("Verdict:"));
  // Signal passed gates → the alert delivered the chart; the briefing must not
  // duplicate it. (Gated/cooldown/tracking branches attach it instead.)
  expect("alert-path briefing carries no extra chart", briefingReply.chart == null);

  // Same pipeline but with an impossible confidence bar: the setup is gated, so
  // the briefing itself must carry the setup chart for the user's decision.
  const gatedReply = await scanSymbol(
    { symbol: "BTCUSDT", enabled: true, scan_interval: 0, asset_class: "manual", min_confidence: 101 },
    scanDeps,
    { manual: true },
  );
  expect("gated briefing has a gate verdict", gatedReply.text.includes("gated"));
  expect(
    "gated briefing attaches the setup chart",
    gatedReply.chart != null && gatedReply.chart.byteLength > 0,
    gatedReply.chart == null ? "no chart buffer" : `${gatedReply.chart.byteLength} bytes`,
  );

  console.log("\n── /recent evaluation card ────────────────────────────────");
  const closedRow = (over: Partial<OutcomeRow>): OutcomeRow =>
    ({
      id: 1, symbol: "ZECUSDT", direction: "long", strategy: "momentum", source: "signal",
      entry_price: 100, hit_price: 105, status: "TP_HIT", duration_ms: 3_600_000,
      ...over,
    }) as unknown as OutcomeRow;
  // Newest first, like fetchRecentClosedOutcomes returns them.
  const recentRows = [
    closedRow({ id: 11, sl: 98 }), // +5% = +2.5R win
    closedRow({ id: 12, status: "SL_HIT", hit_price: 97, sl: 97, strategy: "trend_pullback" }), // −3% = −1R loss
    closedRow({
      id: 13, status: "CLOSED", source: "bybit", strategy: "manual", direction: "short",
      hit_price: 98, sl: 0, original_factors: { size: 2 }, duration_ms: 2_040_000,
    }), // +2% short, $4, no SL → no R
  ];

  const root = formatRecentRoot(recentRows);
  expect("root shows newest-first streak", root.includes("Current Streak:") && root.includes("\uD83D\uDFE2\uD83D\uDD34\uD83D\uDFE2"), root);
  expect("root sums net R over R-known trades", root.includes("Net:") && root.includes("+1.5R") && root.includes("\uD83D\uDFE2"), root);
  expect("root computes WR without counts", root.includes("WR:") && root.includes("67%") && !root.includes("2W/1L"));
  expect("root shows $ PnL when size known", root.includes("+$4.00"), root);
  expect("root names best and worst (two-line)", root.includes("Best:") && root.includes("\uD83D\uDFE2 ZEC") && root.includes("+2.5R") && root.includes("Worst:") && root.includes("\uD83D\uDD34 ZEC") && root.includes("-1.0R"), root);
  expect("root empty state", formatRecentRoot([]) === "\uD83D\uDCD2 No closed trades yet.");

  const list = formatRecentList(recentRows);
  expect("list numbers trades to match buttons", list.includes("1. \uD83D\uDFE2 ZEC LONG") && list.includes("+2.5R") && list.includes("2. \uD83D\uDD34 ZEC LONG") && list.includes("-1.0R"));
  expect("list falls back to % when no R", list.includes("3. \uD83D\uDFE2 ZEC SHORT") && list.includes("+2.00%"), list);

  const tradeCard = formatRecentTrade(recentRows[2]!);
  expect("trade view shows $ result", tradeCard.includes("+$4.00"), tradeCard);
  expect("trade view shows R when known", formatRecentTrade(recentRows[0]!).includes("+2.5R"));
  expect("trade view shows duration", tradeCard.includes("Duration:") && tradeCard.includes("34m"), tradeCard);

  const perf = formatRecentPerformance(recentRows);
  expect("performance shows net R window label", perf.includes("Last 3:") && perf.includes("+1.5R"), perf);
  expect("performance computes profit factor", perf.includes("Profit Factor:") && perf.includes("2.50"), perf);
  expect("performance computes expectancy", perf.includes("Expectancy:") && perf.includes("+0.8R") && perf.includes("/ trade"), perf);
  expect("performance shows avg win/loss labels", perf.includes("Avg Win:") && perf.includes("+2.5R") && perf.includes("Avg Loss:") && perf.includes("-1.0R"));
  expect("coinName strips quote suffix", coinName("ZECUSDT") === "ZEC" && coinName("BTCPERP") === "BTC");

  console.log("\n── interactive trade card views ───────────────────────────");
  const cardRow = {
    id: 32, symbol: "HYPEUSDT", direction: "short", strategy: "manual", source: "bybit",
    status: "ACTIVE", management_state: "MANAGED",
    entry_price: 55.701077, sl: 56.26, tp: 54.725,
    trade_health: 62,
    health_components: { structure: 65, momentum: 70, volume: 27, trend_alignment: 100, risk_protection: 48 },
    suggested_stop: 56.1835, suggested_stop_method: "swing",
    original_factors: { size: 6.04 },
    path_probs: { tp_direct: 30, retest_then_tp: 50, sl_hit: 20 },
    management_snapshot: {
      observations: ["Structure intact", "Sellers defending resistance 55.68", "1h trend aligned"],
      warnings: ["Momentum slowing (ADX falling (41→28))", "Support 55.56 nearby"],
      actions: [
        "Move SL to 56.1835 (lower high formed at 56.10, reduces risk)",
        "Take 25% partial while price is rejected",
        "Hold remaining position for TP 54.73",
      ],
      emergency: ["Structure breaks (15m close above 55.68)", "Volume spike buys into resistance"],
      pnl_pct: 0.06, pnl_r: 0.06, price: 55.669, updated_at: new Date().toISOString(),
    },
  } as unknown as OutcomeRow;

  const cardSummary = formatTradeView("summary", cardRow);
  expect("summary leads with a verdict", cardSummary.startsWith("🟢 HOLD"), cardSummary.split("\n")[0]);
  expect("summary shows PnL with $ amount", cardSummary.includes("PnL: +0.06% (+$0.20)"), cardSummary);
  expect("summary falls back to health as confidence", cardSummary.includes("Confidence: 62%"));
  expect("summary shows SL → suggested stop", cardSummary.includes("SL: 56.26 → 56.1835"));
  expect("summary shows expected path", cardSummary.includes("🎯 TP Direct: 30%") && cardSummary.includes("❌ SL: 20%"));
  expect("summary is a 5-second read (≤ 14 lines)", cardSummary.split("\n").length <= 14, `${cardSummary.split("\n").length} lines`);

  const cardAction = formatTradeView("action", cardRow);
  expect("action lists recommendations", cardAction.includes("Recommended:") && cardAction.includes("1. Move SL to 56.1835"));
  expect("action lists exit conditions", cardAction.includes("Exit if:") && cardAction.includes("• Structure breaks"));

  const cardAnalysis = formatTradeView("analysis", cardRow);
  expect("analysis shows component scores", cardAnalysis.includes("Volume: 27") && cardAnalysis.includes("Trend: 100"));
  expect("analysis shows observations & warnings", cardAnalysis.includes("✓ Structure intact") && cardAnalysis.includes("⚠ Momentum slowing"));

  const cardRisk = formatTradeView("risk", cardRow);
  expect("risk computes live RR", cardRisk.includes("Current RR: 1.6"), cardRisk);
  expect("risk maps health band to level", cardRisk.includes("Risk: Medium") && cardRisk.includes("Trade Health: 62/100"));
  expect("risk names the weakest factor", cardRisk.includes("Weakest factor: Volume (27)"));

  const exitRow = { ...cardRow, trade_health: 30 } as unknown as OutcomeRow;
  expect("low health verdict is EXIT", formatTradeView("summary", exitRow).startsWith("🔴 EXIT"));
  const reduceRow = { ...cardRow, trade_health: 45 } as unknown as OutcomeRow;
  expect("weak health verdict is REDUCE", formatTradeView("summary", reduceRow).startsWith("🟠 REDUCE"));
  const noStopRow = { ...cardRow, sl: 0, suggested_stop: null } as unknown as OutcomeRow;
  expect("missing stop flagged in risk view", formatTradeView("risk", noStopRow).includes("No stop set"));

  console.log("\n── formatted output samples ───────────────────────────────");
  console.log("· Trade card (summary):\n");
  console.log(cardSummary);
  console.log("\n· Trade card (action):\n");
  console.log(cardAction);
  console.log("\n· Trade card (analysis):\n");
  console.log(cardAnalysis);
  console.log("\n· Trade card (risk):\n");
  console.log(cardRisk);
  console.log("· Manual scan briefing:\n");
  console.log(briefing);
  console.log("\n· Signal alert with plan + paths:\n");
  console.log(formatAlert(signal));
  console.log("\n· Management event alert:\n");
  console.log(formatManagementEvent("ZECUSDT", "long", sick.events[0]!, sick));
  console.log("\n· Living trade report:\n");
  const fakeRow = {
    id: 42, symbol: "ZECUSDT", direction: "long", strategy: "momentum", source: "signal",
    status: "ACTIVE", management_state: "MANAGED",
    entry_price: healthyTrade.entryPrice, sl: healthyTrade.sl, tp: healthyTrade.tp,
  } as unknown as OutcomeRow;
  console.log(formatTradeReport(fakeRow, healthy));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
