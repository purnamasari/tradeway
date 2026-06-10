// Symbol resolution — lets users say "ZEC", "zec", "ZEC/USDT", or "ZECUSDT" and
// scan ANY coin Bybit lists, not just the watchlist. Backed by the public
// instruments-info endpoint (cached in memory, refreshed periodically) with
// "did you mean" suggestions for typos. Degrades to naive USDT-pair completion
// when the instrument list is unreachable, so a network blip never blocks a scan.
import { logger } from "../logger.js";

const BASE = "https://api.bybit.com";
const REFRESH_MS = 6 * 60 * 60 * 1000; // instrument listings change rarely
const PAGE_LIMIT = 1000;

/** Quote suffixes we try when the user types a bare coin name. USDT first —
 *  it is the overwhelmingly common perp quote and the watchlist convention. */
const QUOTE_SUFFIXES = ["USDT", "USDC", "PERP", "USD"];

/**
 * Normalize user ticker input to a Bybit symbol: trims, uppercases, strips
 * separators, and appends USDT when no quote currency is present — so `zec`,
 * `BTC`, and `wld` all resolve to their USDT perpetuals.
 */
export function normalizeSymbol(input: string): string {
  const s = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return s;
  return QUOTE_SUFFIXES.some((q) => s.endsWith(q)) ? s : `${s}USDT`;
}

// ── Instrument list (cached) ─────────────────────────────────────────────────

interface InstrumentCache {
  symbols: Set<string>;
  fetchedAt: number;
}

const cacheByCategory = new Map<string, InstrumentCache>();

interface InstrumentsResult {
  list: Array<{ symbol: string; status: string }>;
  nextPageCursor?: string;
}

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

/** Fetch every actively trading symbol in the category (paginated). */
async function fetchInstrumentSymbols(category: string): Promise<Set<string>> {
  const symbols = new Set<string>();
  let cursor: string | undefined;

  // Defensive page bound; linear is ~2 pages at limit=1000.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ category, limit: String(PAGE_LIMIT) });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${BASE}/v5/market/instruments-info?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status} for instruments-info`);
    const body = (await res.json()) as BybitResponse<InstrumentsResult>;
    if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}: ${body.retMsg}`);

    for (const i of body.result.list) {
      if (i.status === "Trading") symbols.add(i.symbol);
    }
    if (!body.result.nextPageCursor || body.result.list.length === 0) break;
    cursor = body.result.nextPageCursor;
  }
  return symbols;
}

/**
 * The cached instrument set, or null when Bybit is unreachable (callers degrade
 * to unverified naive resolution rather than blocking the scan).
 */
export async function loadInstruments(category: string): Promise<Set<string> | null> {
  const cached = cacheByCategory.get(category);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return cached.symbols;
  try {
    const symbols = await fetchInstrumentSymbols(category);
    cacheByCategory.set(category, { symbols, fetchedAt: Date.now() });
    logger.info(`[symbols] loaded ${symbols.size} trading instruments (${category})`);
    return symbols;
  } catch (err) {
    logger.warn(`[symbols] instruments-info failed: ${(err as Error).message}`);
    // A stale cache beats no cache when the refresh fails.
    return cached?.symbols ?? null;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

export type SymbolResolution =
  | { ok: true; symbol: string; verified: boolean }
  | { ok: false; error: string };

/**
 * Pure matching core (separated from the network fetch for testability):
 * try the normalized input as-is, then with each quote suffix appended,
 * against a known instrument set. Misses come back with close-match suggestions.
 */
export function matchSymbol(rawInput: string, instruments: Set<string>): SymbolResolution {
  const norm = rawInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm) return { ok: false, error: "Empty symbol. Try e.g. ZEC, BTC, or WLDUSDT." };

  if (instruments.has(norm)) return { ok: true, symbol: norm, verified: true };
  for (const quote of QUOTE_SUFFIXES) {
    const candidate = `${norm}${quote}`;
    if (instruments.has(candidate)) return { ok: true, symbol: candidate, verified: true };
  }

  const suggestions = suggest(norm, instruments);
  return {
    ok: false,
    error:
      `Unknown symbol "${norm}" on Bybit.` +
      (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
  };
}

/**
 * Resolve free-form user input ("ZEC", "zec/usdt", "BTCUSDT") to a tradable
 * Bybit symbol, validated against the live instrument list when available.
 */
export async function resolveSymbol(input: string, category: string): Promise<SymbolResolution> {
  const instruments = await loadInstruments(category);
  if (!instruments) {
    const naive = normalizeSymbol(input);
    if (!naive) return { ok: false, error: "Empty symbol. Try e.g. ZEC, BTC, or WLDUSDT." };
    return { ok: true, symbol: naive, verified: false };
  }
  return matchSymbol(input, instruments);
}

/** Close matches for a typo'd coin: prefix matches first, then substring. */
function suggest(norm: string, instruments: Set<string>, max = 4): string[] {
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const s of instruments) {
    if (s.startsWith(norm)) prefix.push(s);
    else if (norm.length >= 3 && s.includes(norm)) contains.push(s);
  }
  prefix.sort((a, b) => a.length - b.length || a.localeCompare(b));
  contains.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [...prefix, ...contains].slice(0, max);
}
