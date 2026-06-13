// explain — ad-hoc "why is there no signal?" diagnostic. Evaluates each enabled
// engine strategy against the SAME decision context the live cycle builds, and
// prints the gate that rejected each one (or the entry it would emit). Also
// prints a gate funnel across the evaluated symbols.
//
//   pnpm explain -- BTCUSDT                 # one symbol
//   pnpm explain -- BTCUSDT ETHUSDT SOLUSDT # several
//   pnpm explain                            # all enabled watchlist symbols
//
// Read-only: no positions, no orders, no DB writes. Runs where market data is
// reachable (VPS, or anywhere with DATABASE_URL / Bybit REST).
import { loadRules, loadWatchlist, loadEnv } from "../config.js";
import { createDb } from "../db/index.js";
import {
  CachingMarketDataProvider,
  HybridMarketDataProvider,
  LiveMarketDataProvider,
  type MarketDataProvider,
} from "../data/provider.js";
import { StrategyRegistry, type Strategy } from "../engine/index.js";
import { funnel, funnelSnapshot, renderFunnel } from "../engine/index.js";
import { buildContext, strategyPipelines } from "../engine/cycle.js";
import { createH18Strategy } from "../strategies/h18.js";
import { createSmcStrategy } from "../strategies/smc.js";
import { createSmcScalpStrategy } from "../strategies/smc-scalp.js";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch {}

const CONTEXT_HEADROOM = 512;

async function main() {
  const rules = loadRules();
  const watchlist = loadWatchlist();
  const env = loadEnv();

  const enabled = watchlist.assets.filter((a) => a.enabled).map((a) => a.symbol);
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const symbols = args.length ? args.map((s) => s.toUpperCase()) : enabled;

  // Same strategy set the live engine would register.
  const available: Record<string, () => Strategy> = {
    H18: () => createH18Strategy(rules.regime),
    SMC: () => createSmcStrategy(rules.regime),
    SMC_SCALP: () => createSmcScalpStrategy(rules.regime),
  };
  const registry = new StrategyRegistry();
  for (const id of rules.engine.strategies) {
    const factory = available[id];
    if (factory) registry.register(factory());
    else logger.warn(`[explain] unknown strategy "${id}" in rules.engine.strategies — skipped`);
  }
  const strategies = registry.all();
  if (strategies.length === 0) {
    console.log("No strategies enabled in rules.engine.strategies — nothing to explain.");
    process.exit(0);
  }

  // Provider stack: DB-backed (with live top-up) when DATABASE_URL is set, else
  // straight from the exchange.
  const db = await createDb(env.databaseUrl);
  const data: MarketDataProvider = db
    ? new CachingMarketDataProvider(new HybridMarketDataProvider(db, env.bybitCategory))
    : new LiveMarketDataProvider(env.bybitCategory);

  const depth = Math.max(60, ...strategies.map((s) => s.minBars)) + CONTEXT_HEADROOM;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    let sctx;
    try {
      sctx = await buildContext(symbol, data, rules, depth, nowSec, true);
    } catch (err) {
      console.log(`  data error: ${(err as Error).message}`);
      continue;
    }
    if (!sctx) {
      console.log("  no decision context (insufficient history or stale data)");
      continue;
    }
    console.log(`  price ${sctx.price} · regime ${sctx.regime ?? "?"} · trend ${sctx.trend ?? "?"} · 15m bars ${sctx.candles15m.length}`);
    for (const strategy of strategies) {
      funnel.evaluated(strategy.id);
      const d = strategy.evaluateEntry(sctx);
      if (d.enter) {
        funnel.signal(strategy.id);
        console.log(`  ${strategy.id.padEnd(10)}: ✅ ENTER ${d.intent.side}`);
      } else {
        funnel.rejected(strategy.id, d.stage);
        console.log(`  ${strategy.id.padEnd(10)}: ❌ rejected — stage=${d.stage ?? "?"} · ${d.reason}`);
      }
    }
  }

  console.log("\n=== gate funnel (this run) ===");
  console.log(renderFunnel(funnelSnapshot(strategyPipelines(strategies))));
  process.exit(0);
}

main().catch((e) => {
  logger.error(`[explain] failed: ${(e as Error).message}`);
  process.exit(1);
});
