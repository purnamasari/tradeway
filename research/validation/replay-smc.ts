// Replay validation: the PRODUCTION SMC plug-in + engine position machinery
// (src/strategies/smc.ts, src/engine/*) driven bar-by-bar over the research
// candle caches, diffed against the research reference
// (research/validation/smc.ts via runStrategy).
//
//   pnpm test:smc:replay [--symbols=BTCUSDT,ETHUSDT]
//
// Detection is shared code (src/strategies/smc-core.ts), so the only expected
// differences are windowing artifacts: production computes ATR(15m) over a
// sliding SMC_CONTEXT_BARS window vs the research full-series ATR (Wilder
// smoothing converges — entry sets can differ only marginally), and max-hold
// expiry lands within ±3 bars (fill-close vs fill-open accounting).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRules } from "../../src/config.js";
import { loadSymbolCache } from "../harness.js";
import { loadContexts } from "./fast-context.js";
import { runStrategyAll } from "./strategy.js";
import { smcStrategy } from "./smc.js";
import type { ValTrade } from "./metrics.js";
import { createSmcStrategy, SMC_CONTEXT_BARS } from "../../src/strategies/smc.js";
import {
  createPosition,
  evaluateBar,
  applyExitDecision,
  type Position,
  type StrategyContext,
} from "../../src/engine/index.js";

const SYMBOLS = ((process.argv.find((a) => a.startsWith("--symbols=")) ?? "--symbols=BTCUSDT,ETHUSDT").slice(10)).split(",");
const PREFIX = "BNALL_";
const WARMUP = 2880;

interface EngineTrade {
  symbol: string;
  detectedAt: number; // ms
  side: "LONG" | "SHORT";
  entryLow: number;
  entryHigh: number;
  initialStop: number;
  filled: boolean;
  status: string;
  exitTimeSec: number | null;
  grossR: number | null;
}

/** Drive the production strategy + engine exit machinery over cached candles. */
function replayEngine(symbol: string): EngineTrade[] {
  const rules = loadRules();
  const strategy = createSmcStrategy(rules.regime);
  const candles = loadSymbolCache(PREFIX + symbol).candles15m;
  const trades: EngineTrade[] = [];
  let pos: Position | null = null;
  let current: EngineTrade | null = null;
  let seq = 0;

  const ctxAt = (i: number): StrategyContext => ({
    symbol,
    closeTime: candles[i]!.time + 900,
    price: candles[i]!.close,
    candles15m: candles.slice(Math.max(0, i - (SMC_CONTEXT_BARS - 1)), i + 1),
    candles1h: [],
    regime: null,
    trend: null,
    atr15: null,
    atr1h: null,
    fundingRate: null,
    openInterest: null,
    extras: {},
  });

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i]!;
    const closeMs = (bar.time + 900) * 1000;
    const sctx = ctxAt(i);

    if (pos && current) {
      let p = evaluateBar(pos, bar, closeMs).position;
      if (p.status === "OPEN" && pos.status === "PENDING_ENTRY") current.filled = true;
      if (p.status === "OPEN") {
        const nextState = strategy.updateState(sctx, p);
        if (nextState !== p.state) p = { ...p, state: nextState };
        p = applyExitDecision(p, strategy.evaluateExit(sctx, p), sctx.price, closeMs).position;
      }
      if (p.status !== "OPEN" && p.status !== "PENDING_ENTRY") {
        current.filled = current.filled || p.filledAt != null;
        current.status = p.status;
        current.exitTimeSec = p.closedAt != null ? Math.round(p.closedAt / 1000) : null;
        const risk = Math.abs(p.entryPrice - current.initialStop) || 1e-9;
        current.grossR =
          p.exitPrice != null && p.filledAt != null
            ? ((p.exitPrice - p.entryPrice) / risk) * (p.side === "LONG" ? 1 : -1)
            : null;
        if (current.filled) trades.push(current);
        pos = null;
        current = null;
      } else {
        pos = p;
      }
    }

    if (!pos) {
      const decision = strategy.evaluateEntry(sctx);
      if (decision.enter) {
        const risk = { approved: true, qty: 0, riskAmount: 0, model: "replay", reasons: [] };
        pos = createPosition(decision.intent, risk, closeMs, `replay_${++seq}`);
        current = {
          symbol,
          detectedAt: closeMs,
          side: decision.intent.side,
          entryLow: decision.intent.entryZone.low,
          entryHigh: decision.intent.entryZone.high,
          initialStop: decision.intent.stopPrice,
          filled: false,
          status: "PENDING",
          exitTimeSec: null,
          grossR: null,
        };
      }
    }
  }
  return trades;
}

function main() {
  const missing = SYMBOLS.filter(
    (s) => !existsSync(fileURLToPath(new URL(`../data/${PREFIX}${s}.json`, import.meta.url))),
  );
  if (missing.length) {
    console.error(
      `Missing research candle cache(s): ${missing.map((s) => `research/data/${PREFIX}${s}.json`).join(", ")}\n` +
        `Build them first (downloads Binance Vision dumps, ~40MB/symbol):\n` +
        `  ./research/fetch-replay-data.sh "${SYMBOLS.join(" ")}"`,
    );
    process.exit(1);
  }

  const rules = loadRules();
  let pass = true;

  for (const symbol of SYMBOLS) {
    const ctxs = loadContexts([symbol], PREFIX, rules);
    const research: ValTrade[] = runStrategyAll(ctxs, smcStrategy());
    const engine = replayEngine(symbol);

    const refByTime = new Map(research.map((t) => [t.detectedAt, t]));
    const engByTime = new Map(engine.map((t) => [t.detectedAt, t]));

    let matched = 0;
    let sideZoneOk = 0;
    let exitExact = 0;
    let exitTolerated = 0;
    let exitMismatch = 0;
    let sumAbsDR = 0;

    for (const ref of research) {
      const eng = engByTime.get(ref.detectedAt);
      if (!eng) continue;
      matched++;
      const sideOk = (ref.direction === "long") === (eng.side === "LONG");
      if (sideOk) sideZoneOk++;

      // Status families: research SL|BE → engine EXITED_STOP · TP →
      // EXITED_TARGET · EXPIRED → EXITED_TIME. The reference exit time below
      // approximates fill ≈ detection, but SMC fills on a RETRACE up to the
      // 2h entry TTL (8 bars) after detection and the 48h hold runs from the
      // fill — so time exits may legitimately land up to TTL + ±3 bars from
      // the approximation (stop/target exits are price-pinned and unaffected).
      const refStop = ref.status === "SL" || ref.status === "BE";
      const refTp = ref.status === "TP";
      const engStop = eng.status === "EXITED_STOP";
      const engTp = eng.status === "EXITED_TARGET";
      const refTime = ref.detectedAt / 1000 + (ref.durationMs ?? 0) / 1000;
      const dtBars = eng.exitTimeSec != null ? Math.abs(eng.exitTimeSec - refTime) / 900 : Infinity;
      const dR = eng.grossR != null ? Math.abs(eng.grossR - ref.grossR) : Infinity;
      sumAbsDR += Number.isFinite(dR) ? dR : 0;
      const dtTimeTol = 8 + 3; // entry-TTL fill slack + hold accounting

      if (((refStop && engStop) || (refTp && engTp)) && dR < 1e-6) exitExact++;
      else if (((refStop && engStop) || (refTp && engTp)) && dR < 0.02) exitTolerated++;
      else if (ref.status === "EXPIRED" && eng.status === "EXITED_TIME" && dtBars <= dtTimeTol && dR < 0.25) exitTolerated++;
      else if (ref.status === "EXPIRED" && (engStop || engTp) && dtBars <= dtTimeTol) exitTolerated++; // grazed on the boundary bar
      else exitMismatch++;
    }

    const refOnly = research.filter((t) => !engByTime.get(t.detectedAt)).length;
    const engOnly = engine.filter((t) => !refByTime.get(t.detectedAt)).length;
    const entryParity = research.length ? matched / Math.max(research.length, engine.length) : 1;
    const exitParity = matched ? (exitExact + exitTolerated) / matched : 1;
    const ok = entryParity >= 0.99 && sideZoneOk === matched && exitParity >= 0.99;
    pass &&= ok;

    console.log(
      `${symbol}: research n=${research.length} engine n=${engine.length} matched=${matched} ` +
        `(ref-only ${refOnly}, eng-only ${engOnly})\n` +
        `  entries: parity ${(100 * entryParity).toFixed(1)}% · side/zone ok ${sideZoneOk}/${matched}\n` +
        `  exits:   exact ${exitExact} · tolerated ${exitTolerated} · mismatch ${exitMismatch} ` +
        `· parity ${(100 * exitParity).toFixed(1)}% · mean|ΔR| ${(matched ? sumAbsDR / matched : 0).toFixed(4)}\n` +
        `  ${ok ? "✓ PASS" : "✗ FAIL"}`,
    );
  }

  console.log(pass ? "\nREPLAY VALIDATION PASSED" : "\nREPLAY VALIDATION FAILED");
  process.exit(pass ? 0 : 1);
}

main();
