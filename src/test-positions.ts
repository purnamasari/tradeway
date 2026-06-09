// Live check for the read-only Bybit position feed. Verifies the signed v5 request
// authenticates and prints any open positions.  pnpm test:positions
import { loadEnv } from "./config.js";
import { fetchPositions } from "./data/bybit-private.js";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch {}

async function main() {
  const env = loadEnv();
  if (!env.bybitApiKey || !env.bybitApiSecret) {
    console.error("BYBIT_API_KEY / BYBIT_API_SECRET not set in .env");
    process.exit(1);
  }
  console.log(`Fetching positions (category=${env.bybitCategory})…`);
  const positions = await fetchPositions(
    { apiKey: env.bybitApiKey, apiSecret: env.bybitApiSecret },
    env.bybitCategory,
  );
  console.log(`✓ authenticated — ${positions.length} open position(s):`);
  for (const p of positions) {
    console.log(
      `  ${p.symbol} ${p.side} size=${p.size} avg=${p.avgPrice} ` +
        `SL=${p.stopLoss ?? "—"} TP=${p.takeProfit ?? "—"} uPnL=${p.unrealisedPnl ?? "—"}`,
    );
  }
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
