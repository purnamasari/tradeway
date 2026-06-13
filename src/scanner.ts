// Per-symbol scan pipeline:
//   market data -> regime -> trend -> S/R -> detectors -> gates -> chart -> alert
// Runs all permitted strategy detectors per regime and selects the
// highest combined-score signal.
import type { AssetConfig, GlobalConfig, Rules, Env } from "./config.js";
import type { Cache } from "./cache.js";
import type { Notifier, ScanReply } from "./notify.js";
import type { MarketContext, Signal, RegimeResult, TrendResult, StrategyKind, SRTierSnapshot } from "./types.js";
import type { Db } from "./db/index.js";
import { classifyRegime } from "./regime/engine.js";
import { classifyTrend } from "./ai/trend-classifier.js";
import { buildSRMultiTier } from "./strategy/sr-engine.js";
import { detectLiquiditySweep, type DetectResult } from "./strategy/liquidity-sweep.js";
import { detectTrendPullback } from "./strategy/trend-pullback.js";
import { detectSqueeze } from "./strategy/squeeze.js";
import { detectMomentum } from "./strategy/momentum.js";
import {
  hydrateContextHistory,
  recordMetrics,
  recordRegime,
  recordSignal,
  createOutcome,
  fetchOpenOutcomeForSymbol,
  setSignalAlertRef,
} from "./db/accumulate.js";
import { fetchLastCandles } from "./data/history/repo.js";
import { ema, percentileRank } from "./indicators.js";
import { buildManagementPlan } from "./management/plan.js";
import { estimatePaths } from "./management/paths.js";
import { renderChart } from "./chart/renderer.js";
import { logger } from "./logger.js";
import { recordScanSuccess, recordScanError } from "./health.js";

// Pluggable market-data source (live Bybit or offline mock).
export type ContextProvider = (symbol: string, category: string) => Promise<MarketContext>;

export interface ScannerDeps {
  cache: Cache;
  notifier: Notifier;
  rules: Rules;
  global: GlobalConfig;
  env: Env;
  db: Db;
  getContext: ContextProvider;
}

export interface ScanOptions {
  /** A user-initiated scan (e.g. Telegram /scan): reply with a full decision
   *  briefing (regime/trend/S-R/detector verdicts) instead of a one-liner. */
  manual?: boolean;
}

// Ticker normalization lives with the Bybit instrument resolver; re-exported
// here for callers/tests that treat it as part of the scan surface.
export { normalizeSymbol } from "./data/symbols.js";

/** Combined score for ranking signals when multiple detectors fire. */
function combinedScore(s: Signal): number {
  return s.confidence * 0.6 + s.setup_quality * 0.4;
}

interface DetectorEntry {
  strategy: StrategyKind;
  result: DetectResult;
}

/**
 * Per-scan decision report. Explains, for every detector, whether it fired or
 * why it was rejected, plus the final gate outcome — so a missing alert is
 * always traceable to a specific reason rather than silent.
 */
function logScanDecision(
  symbol: string,
  regime: RegimeResult,
  trend: TrendResult,
  entries: DetectorEntry[],
  outcome: string,
): void {
  const lines = [
    `[scan] ${symbol} · regime=${regime.regime} (ADX ${regime.adx}, ATR%${regime.atrPercentile}) · trend=${trend.trend} (${trend.source})`,
  ];
  for (const { strategy, result } of entries) {
    const label = `${strategy}:`.padEnd(17);
    if (result.signal) {
      const s = result.signal;
      lines.push(`  ${label}detected — conf ${s.confidence}, quality ${s.setup_quality}, RR 1:${s.rr}`);
    } else {
      lines.push(`  ${label}rejected: ${result.reason}`);
    }
  }
  lines.push(`  ${outcome}`);
  logger.info(lines.join("\n"));
}

/**
 * Decision briefing for a manual scan: the full market read plus a verdict, so
 * the user can decide to take, skip, or wait — instead of a bare one-liner.
 */
function buildBriefing(
  symbol: string,
  price: number,
  regime: RegimeResult,
  trend: TrendResult,
  sr: SRTierSnapshot,
  entries: DetectorEntry[],
  verdict: string,
): string {
  const fmtPrice = (n: number) => {
    const abs = Math.abs(n);
    const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
    return Number(n.toFixed(dp)).toString();
  };
  const lines = [
    `🔍 ${symbol} @ ${fmtPrice(price)}`,
    ``,
    `Regime: ${regime.regime} (ADX ${regime.adx} · ATR %ile ${regime.atrPercentile})`,
    `Trend 1h: ${trend.trend} ${trend.confidence}/100 (${trend.source})`,
  ];
  // Scalp levels (15m)
  const scalpParts: string[] = [];
  if (sr.scalp.support) scalpParts.push(`support ${fmtPrice(sr.scalp.support.price)} (${sr.scalp.support.strength})`);
  if (sr.scalp.resistance) scalpParts.push(`resistance ${fmtPrice(sr.scalp.resistance.price)} (${sr.scalp.resistance.strength})`);
  if (scalpParts.length) lines.push(`Scalp: ${scalpParts.join(" · ")}`);
  // Structural levels (weekly)
  const structParts: string[] = [];
  if (sr.structural.support) structParts.push(`sup ${fmtPrice(sr.structural.support.price)} (${sr.structural.support.strength})`);
  if (sr.structural.resistance) structParts.push(`res ${fmtPrice(sr.structural.resistance.price)} (${sr.structural.resistance.strength})`);
  if (structParts.length) lines.push(`Struct: ${structParts.join(" · ")}`);

  lines.push(``, `Detectors:`);
  for (const { strategy, result } of entries) {
    if (result.signal) {
      const s = result.signal;
      lines.push(`✅ ${strategy}: conf ${s.confidence} · quality ${s.setup_quality} · RR 1:${s.rr}`);
    } else {
      lines.push(`· ${strategy}: ${result.reason}`);
    }
  }
  lines.push(``, verdict);
  return lines.join("\n");
}

/**
 * Run the full pipeline for one symbol. Returns the outcome (alert / no-signal /
 * gated / suppressed / error) so callers like the `/scan` command can report the
 * result; the scheduler ignores the return value. With `opts.manual` the text is
 * a full decision briefing instead of one line, and when a candidate setup was
 * detected but no alert fired (gated / already tracking / cooldown) the reply
 * also carries the setup chart — no setup, no chart. When the signal passes
 * gates the alert itself delivers the chart, so the briefing stays text-only.
 */
export async function scanSymbol(
  asset: AssetConfig,
  deps: ScannerDeps,
  opts: ScanOptions = {},
): Promise<ScanReply> {
  const { cache, notifier, rules, global, env, db } = deps;
  const minConfidence = asset.min_confidence ?? global.min_confidence;

  // Heartbeat for the health endpoint. Any non-throwing exit (including the early
  // "no signal"/gate/cooldown returns) is a successful pass; a thrown error is a
  // failure. The `threw` flag lets `finally` tell the two apart across all the
  // early returns without sprinkling calls at every exit point.
  let threw = false;
  try {
    const ctx = await deps.getContext(asset.symbol, env.bybitCategory);
    logger.info(`[scan:auto] ${asset.symbol}: starting scan (regime will follow) ctx.candles15m=${ctx.candles15m.length} candles1h=${ctx.candles1h.length}${opts.manual ? " (manual)" : ""}`);
    ctx.candles1w = db ? await fetchLastCandles(db, asset.symbol, "1w", 100) : [];
    if (ctx.candles15m.length < 60 || ctx.candles1h.length < 60) {
      logger.warn(`[scan] ${asset.symbol}: insufficient candle history, skipping`);
      if (opts.manual) {
        return { text: `⚠ ${asset.symbol}: not enough candle history on Bybit (listing too new or illiquid) — can't scan reliably.` };
      }
      return { text: `${asset.symbol}: insufficient candle history` };
    }

    // Historical context = backfilled market_history (bulk bootstrap) merged with
    // runtime metric_history (accumulated per scan), folded into ctx's percentile/
    // z-score windows. Shared with the edge monitor so both score identically.
    await hydrateContextHistory(db, ctx, rules);

    const regime = classifyRegime(ctx.candles15m, rules.regime, ctx.atrHistory);

    const closes1h = ctx.candles1h.map((c) => c.close);
    const ema20 = ema(closes1h, rules.regime.ema_fast);
    const ema50 = ema(closes1h, rules.regime.ema_slow);
    const trend = await classifyTrend(asset.symbol, ctx.candles1h, ema20, ema50, {
      cache,
      rules: rules.trend,
      geminiApiKey: env.geminiApiKey,
    });

    const price = ctx.candles15m.at(-1)!.close;
    const sr = buildSRMultiTier(ctx.candles15m, ctx.candles1w ?? [], price);

    // ── Persist metrics & regime (no-op if db is null) ────────────────────────
    await recordMetrics(db, ctx, regime);
    await recordRegime(db, asset.symbol, regime);

    // ── Run all permitted detectors ──────────────────────────────────────────
    const entries: DetectorEntry[] = [
      { strategy: "liquidity_sweep", result: detectLiquiditySweep(ctx, regime, trend, sr.scalp, rules) },
      { strategy: "trend_pullback", result: detectTrendPullback(ctx, regime, trend, sr.scalp, rules) },
      { strategy: "squeeze", result: detectSqueeze(ctx, regime, trend, sr.scalp, rules) },
      { strategy: "momentum", result: detectMomentum(ctx, regime, trend, sr.scalp, rules) },
    ];
    const candidates = entries.map((e) => e.result.signal).filter((s): s is Signal => s !== null);

    if (candidates.length === 0) {
      logScanDecision(asset.symbol, regime, trend, entries, "no signal — all detectors rejected");
      if (opts.manual) {
        // No setup → no chart: the briefing alone answers "skip".
        return { text: buildBriefing(asset.symbol, price, regime, trend, sr, entries,
          `Verdict: 😴 No setup — skip. Nothing actionable right now.`) };
      }
      return { text: `${asset.symbol}: no signal (regime ${regime.regime}, trend ${trend.trend})` };
    }

    // Pick the highest combined-score signal.
    candidates.sort((a, b) => combinedScore(b) - combinedScore(a));
    const signal = candidates[0]!;

    // Setup chart for a manual briefing when no alert will fire (gated /
    // already tracking / cooldown). renderChart returns null on failure, so a
    // chart problem degrades the reply to text rather than failing the scan.
    const briefingChart = async (): Promise<Buffer | null> =>
      opts.manual ? renderChart(signal, ctx.candles15m) : null;

    // ── Gates ─────────────────────────────────────────────────────────────────
    let gateReason: string | null = null;
    if (signal.confidence < minConfidence) {
      gateReason = `confidence ${signal.confidence} < ${minConfidence}`;
    } else if (signal.setup_quality < global.min_setup_quality) {
      gateReason = `setup_quality ${signal.setup_quality} < ${global.min_setup_quality}`;
    } else if (signal.rr < global.min_rr) {
      gateReason = `RR ${signal.rr} < ${global.min_rr}`;
    }
    if (gateReason) {
      logScanDecision(asset.symbol, regime, trend, entries, `gate: ${signal.strategy} ${gateReason}`);
      if (opts.manual) {
        return {
          text: buildBriefing(asset.symbol, price, regime, trend, sr, entries,
            `Verdict: ⛔ ${signal.strategy} gated (${gateReason}) — skip for now.`),
          chart: await briefingChart(),
        };
      }
      return { text: `${asset.symbol}: ${signal.strategy} gated — ${gateReason}` };
    }

    // ── Active-signal registry (one active signal per symbol) ────────────────────
    // If this symbol already has an open signal (PENDING_ENTRY or ACTIVE), suppress a
    // new one — the edge monitor sends updates on the existing signal instead. The
    // slot stays occupied even when the edge is INVALIDATED (no auto-close); it frees
    // only when price resolves (TP/SL/expiry). DB-less mode has no registry, so the
    // cooldown below remains the fallback dedupe there.
    const openOutcome = await fetchOpenOutcomeForSymbol(db, asset.symbol);
    if (openOutcome) {
      logScanDecision(
        asset.symbol,
        regime,
        trend,
        entries,
        `suppressed: active signal exists (#${openOutcome.id} ${openOutcome.status}, edge=${openOutcome.edge_state})`,
      );
      if (opts.manual) {
        const health = openOutcome.trade_health != null ? ` · health ${openOutcome.trade_health}` : "";
        const pnl = openOutcome.management_snapshot?.pnl_pct;
        const pnlStr = pnl != null ? ` · ${pnl >= 0 ? "+" : ""}${pnl}%` : "";
        return {
          text: buildBriefing(asset.symbol, price, regime, trend, sr, entries,
            `Verdict: ⏸ Already tracking #${openOutcome.id} (${openOutcome.status}${health}${pnlStr}) — ` +
              `manage the open trade instead (/running for details).`),
          chart: await briefingChart(),
        };
      }
      return { text: `${asset.symbol}: suppressed — active signal #${openOutcome.id} (${openOutcome.status}, edge ${openOutcome.edge_state})` };
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────
    const cooldownKey = `cooldown:${asset.symbol}:${signal.strategy}`;
    if (await cache.get(cooldownKey)) {
      logScanDecision(asset.symbol, regime, trend, entries, `cooldown: suppressing duplicate ${signal.strategy}`);
      if (opts.manual) {
        return {
          text: buildBriefing(asset.symbol, price, regime, trend, sr, entries,
            `Verdict: 🕒 ${signal.strategy} ${signal.direction} is valid (conf ${signal.confidence}, ` +
              `quality ${signal.setup_quality}, RR 1:${signal.rr}) but alerted recently — ` +
              `decide on the existing alert.`),
          chart: await briefingChart(),
        };
      }
      return { text: `${asset.symbol}: cooldown — ${signal.strategy} suppressed` };
    }
    await cache.setex(cooldownKey, global.alert_cooldown_min * 60, "1");

    logScanDecision(
      asset.symbol,
      regime,
      trend,
      entries,
      `gate: ✅ passed → alert ${signal.direction} ${signal.strategy}`,
    );
    logger.info(`[scan:auto] ${asset.symbol}: ${signal.strategy} ${signal.direction} conf=${signal.confidence} quality=${signal.setup_quality} rr=${signal.rr} — sending alert${opts.manual ? " (manual)" : ""}`);

    // ── Trade management plan + expected paths ────────────────────────────────
    // Attached to the signal itself so the alert shows the full battle plan and
    // the outcome row seeds the live manager with the same numbers.
    signal.plan = buildManagementPlan(signal, rules);
    const entryMid = (signal.entry_low + signal.entry_high) / 2;
    signal.paths =
      estimatePaths({
        direction: signal.direction,
        price,
        entry: entryMid,
        sl: signal.sl,
        tp: signal.tp,
        strength: (signal.confidence * 0.6 + signal.setup_quality * 0.4) / 100,
        strategy: signal.strategy,
        volumePercentile: percentileRank(
          ctx.candles15m.at(-1)?.volume ?? 0,
          (ctx.volumeHistory && ctx.volumeHistory.length >= 50
            ? ctx.volumeHistory
            : ctx.candles15m.map((c) => c.volume).slice(-120)),
        ),
      }) ?? undefined;

    // ── Chart rendering (failure never blocks alert) ─────────────────────────
    let chartPng: Buffer | null = null;
    try {
      chartPng = await renderChart(signal, ctx.candles15m);
    } catch (err) {
      logger.warn(`[scan] Chart render failed for ${asset.symbol}: ${(err as Error).message}`);
    }

    // ── Persist signal, (maybe) create outcome & notify ───────────────────────
    // When require_follow is on and the notifier is interactive (Telegram), the
    // signal is NOT tracked yet — the user activates it by pressing Follow, which
    // creates the outcome. Otherwise (console, or flag off) auto-track as before.
    const signalId = await recordSignal(db, signal);
    const followable = rules.lifecycle.require_follow && notifier.interactive && signalId !== null;
    // Send first so we capture the Telegram message id, then persist it: edge updates
    // EDIT this message in place rather than posting new ones. For an auto-tracked
    // (non-followable) signal the outcome is created here with that same ref.
    const sent = await notifier.send(signal, chartPng, { signalId: signalId ?? undefined, followable });
    if (signalId !== null) {
      await setSignalAlertRef(db, signalId, sent);
      if (!followable) {
        await createOutcome(db, signal, signalId, true, sent);
      }
    }

    if (opts.manual) {
      // The alert message above already delivered the chart (with Follow/Skip),
      // so the briefing reply stays text-only — no duplicate image.
      return { text: buildBriefing(asset.symbol, price, regime, trend, sr, entries,
        `Verdict: 🚨 Signal sent — ${signal.direction.toUpperCase()} ${signal.strategy} ` +
          `(conf ${signal.confidence}, quality ${signal.setup_quality}, RR 1:${signal.rr})` +
          (followable ? `. Decide with Follow / Skip on the alert.` : `.`)) };
    }
    return { text:
      `${asset.symbol}: ✅ ${signal.direction} ${signal.strategy} ` +
      `(conf ${signal.confidence}, quality ${signal.setup_quality}, RR 1:${signal.rr})` +
      (followable ? " — Follow to track" : "")
    };
  } catch (err) {
    threw = true;
    recordScanError(asset.symbol, (err as Error).message);
    logger.error(`[scan] ${asset.symbol} failed: ${(err as Error).message}`);
    return { text: `${asset.symbol}: scan error — ${(err as Error).message}` };
  } finally {
    if (!threw) recordScanSuccess(asset.symbol);
  }
}
