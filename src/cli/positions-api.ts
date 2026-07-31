// positions-api — tiny read-only HTTP view of the bot's live Binance futures positions.
//
//   pnpm positions:api
//
// Exists so the Market Pulse Mini App can render a positions widget: its FastAPI
// layer proxies to this process. Binds 127.0.0.1 only — never expose it directly.
//
// Read-only end to end: only calls Binance USDⓈ-M futures' positionRisk endpoint
// (never places, modifies or closes orders) and touches neither the DB nor the engine.
//
//   GET /healthz    -> {"ok":true}
//   GET /positions  -> [{ symbol, side, size, entryPrice, markPrice, unrealisedPnl, leverage }]
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { logger } from "../logger.js";

try { process.loadEnvFile(new URL("../../.env", import.meta.url)); } catch {}

const HOST = "127.0.0.1";
const PORT = 8100;

const API_KEY = process.env.BINANCE_API_KEY || process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET || process.env.BYBIT_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error("BINANCE_API_KEY / BINANCE_API_SECRET not set in .env");
  process.exit(1);
}

/** Compact wire shape for the Mini App — a flat subset of the Binance position. */
interface PositionView {
  symbol: string;
  side: "Buy" | "Sell";
  size: number;
  entryPrice: number;
  markPrice: number | null;
  unrealisedPnl: number | null;
  leverage: number | null;
}

interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
}

async function positionsView(): Promise<PositionView[]> {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = createHmac("sha256", API_SECRET!).update(query).digest("hex");

  const res = await fetch(`https://fapi.binance.com/fapi/v2/positionRisk?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": API_KEY! },
  });
  if (!res.ok) {
    throw new Error(`Binance futures request failed: ${res.status}`);
  }
  const rows = (await res.json()) as BinancePositionRisk[];

  const view: PositionView[] = [];
  for (const p of rows) {
    const amt = Number(p.positionAmt);
    if (amt === 0) continue;
    view.push({
      symbol: p.symbol,
      side: amt < 0 ? "Sell" : "Buy",
      size: Math.abs(amt),
      entryPrice: Number(p.entryPrice),
      markPrice: Number(p.markPrice),
      unrealisedPnl: Number(p.unRealizedProfit),
      leverage: Number(p.leverage),
    });
  }
  return view;
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0]!;

  const send = (code: number, body: unknown) => {
    logger.info(`${method} ${path} ${code}`);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (method !== "GET") {
    send(405, { error: "method not allowed" });
    return;
  }
  if (path === "/healthz") {
    send(200, { ok: true });
    return;
  }
  if (path === "/positions") {
    positionsView()
      .then((view) => send(200, view))
      // Message only — never surface credentials or the raw Binance payload.
      .catch((err: Error) => send(500, { error: err.message }));
    return;
  }
  send(404, { error: "not found" });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  logger.error(`[positions-api] could not bind ${HOST}:${PORT} — ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  logger.info(`[positions-api] listening on http://${HOST}:${PORT}/positions`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
