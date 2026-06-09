// Bybit v5 PRIVATE (authenticated) market endpoints. READ-ONLY: this module only
// ever reads account state (open positions). It never places, modifies, or closes
// orders. Use a read-only API key.
//
// Signing (v5): sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString)
// sent as hex, with headers X-BAPI-API-KEY / X-BAPI-SIGN / X-BAPI-TIMESTAMP /
// X-BAPI-RECV-WINDOW (and X-BAPI-SIGN-TYPE=2 for HMAC).
// Docs: https://bybit-exchange.github.io/docs/v5/position
import { createHmac } from "node:crypto";

const BASE = "https://api.bybit.com";
const RECV_WINDOW = "5000";

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

export interface BybitCredentials {
  apiKey: string;
  apiSecret: string;
}

/** A live open position read from Bybit (size > 0). */
export interface BybitPosition {
  symbol: string;
  side: "Buy" | "Sell";
  size: number;
  avgPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealisedPnl: number | null;
  markPrice: number | null;
}

/** Build the signed headers for a GET request with the given query string. */
function signGet(creds: BybitCredentials, queryString: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const payload = timestamp + creds.apiKey + RECV_WINDOW + queryString;
  const sign = createHmac("sha256", creds.apiSecret).update(payload).digest("hex");
  return {
    "X-BAPI-API-KEY": creds.apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "X-BAPI-SIGN": sign,
    "X-BAPI-SIGN-TYPE": "2",
  };
}

async function getPrivate<T>(
  creds: BybitCredentials,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  // Bybit expects the same param order in the signed string and the URL.
  const queryString = new URLSearchParams(params).toString();
  const url = `${BASE}${path}?${queryString}`;
  const res = await fetch(url, {
    headers: signGet(creds, queryString),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status} for ${path}`);
  const body = (await res.json()) as BybitResponse<T>;
  if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}: ${body.retMsg}`);
  return body.result;
}

const num = (v: string | undefined): number | null =>
  v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * Fetch all open positions for the given category (linear settles in USDT). Returns
 * only positions with non-zero size. Never throws on an empty book — only on a
 * transport/auth error, which the caller logs and skips.
 */
export async function fetchPositions(
  creds: BybitCredentials,
  category: string,
): Promise<BybitPosition[]> {
  // linear requires either `symbol` or `settleCoin`; settleCoin=USDT returns the book.
  const params: Record<string, string> = { category };
  if (category === "linear") params.settleCoin = "USDT";

  const result = await getPrivate<{ list: Array<Record<string, string>> }>(
    creds,
    "/v5/position/list",
    params,
  );

  const out: BybitPosition[] = [];
  for (const p of result.list) {
    const size = num(p.size) ?? 0;
    if (size <= 0) continue; // flat / closed leg
    const side = p.side === "Sell" ? "Sell" : "Buy";
    out.push({
      symbol: p.symbol!,
      side,
      size,
      avgPrice: num(p.avgPrice) ?? 0,
      stopLoss: num(p.stopLoss),
      takeProfit: num(p.takeProfit),
      unrealisedPnl: num(p.unrealisedPnl),
      markPrice: num(p.markPrice),
    });
  }
  return out;
}
