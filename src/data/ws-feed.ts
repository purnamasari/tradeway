// Bybit v5 public WebSocket market feed.
//
// Replaces per-scan REST polling: candle/ticker data is streamed and kept in
// rolling in-memory buffers, so a scan reads current data instantly instead of
// firing six REST calls each time. Funding/OI *history* (needed for percentile
// windows) isn't streamed, so it is seeded over REST and refreshed by the poller.
//
// Resilience: pings every 20s, auto-reconnects with capped backoff, and re-seeds
// candle buffers over REST after a reconnect so a dropped socket can't silently
// leave indicators running on stale data. Liveness is surfaced via health().
//
// Uses the WebSocket global built into Node (>=21) — no extra dependency.
import type { Candle, MarketContext, Timeframe } from "../types.js";
import { fetchCandles, fetchTicker, fetchFundingHistory, fetchOIHistory } from "./bybit.js";
import { applyKline, intervalsBehind, type KlineUpdate } from "./candle-buffer.js";
import { logger } from "../logger.js";

const BYBIT_INTERVAL: Record<Timeframe, string> = { "1m": "1", "15m": "15", "1h": "60" };
const INTERVAL_TO_TF: Record<string, Timeframe> = { "1": "1m", "15": "15m", "60": "1h" };
const INTERVAL_SEC: Record<Timeframe, number> = { "1m": 60, "15m": 900, "1h": 3_600 };

const BUFFER_CAP = 250; // keep a little more than the 200 indicators need
const SEED_LIMIT = 200;
const PING_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const SUB_CHUNK = 10; // Bybit caps args per subscribe frame

interface SymbolState {
  candles1m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  lastPrice: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  fundingHistory: number[];
  oiHistory: number[];
  lastKlineAt: number; // ms epoch of last kline message
}

function emptyState(): SymbolState {
  return {
    candles1m: [],
    candles15m: [],
    candles1h: [],
    lastPrice: null,
    fundingRate: null,
    openInterest: null,
    fundingHistory: [],
    oiHistory: [],
    lastKlineAt: 0,
  };
}

export class MarketFeed {
  private states = new Map<string, SymbolState>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private readonly url: string;

  constructor(
    private symbols: string[],
    private category: string,
  ) {
    this.url = `wss://stream.bybit.com/v5/public/${category === "spot" ? "spot" : "linear"}`;
  }

  /** REST-seed all buffers, then open the socket. Resolves once seeding is done. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.seedAll();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ── Seeding (REST) ────────────────────────────────────────────────────────────

  private async seedAll(): Promise<void> {
    // Seed sequentially-ish but concurrently per symbol; tolerate partial failure
    // (a symbol that fails to seed simply has empty buffers and is skipped at scan).
    await Promise.all(this.symbols.map((s) => this.seedSymbol(s)));
    const ready = [...this.states.values()].filter((s) => s.candles15m.length > 0).length;
    logger.info(`[ws] seeded ${ready}/${this.symbols.length} symbols over REST`);
  }

  private async seedSymbol(symbol: string): Promise<void> {
    try {
      const [c1m, c15m, c1h, ticker, funding, oi] = await Promise.all([
        fetchCandles(symbol, "1m", this.category, SEED_LIMIT),
        fetchCandles(symbol, "15m", this.category, SEED_LIMIT),
        fetchCandles(symbol, "1h", this.category, SEED_LIMIT),
        fetchTicker(symbol, this.category),
        fetchFundingHistory(symbol, this.category, SEED_LIMIT),
        fetchOIHistory(symbol, this.category, SEED_LIMIT),
      ]);
      const st = this.states.get(symbol) ?? emptyState();
      st.candles1m = c1m;
      st.candles15m = c15m;
      st.candles1h = c1h;
      st.lastPrice = ticker.lastPrice;
      st.fundingRate = ticker.fundingRate;
      st.openInterest = ticker.openInterest;
      st.fundingHistory = funding;
      st.oiHistory = oi;
      st.lastKlineAt = Date.now();
      this.states.set(symbol, st);
    } catch (err) {
      logger.warn(`[ws] seed failed for ${symbol}: ${(err as Error).message}`);
      if (!this.states.has(symbol)) this.states.set(symbol, emptyState());
    }
  }

  /** Refresh funding/OI history + latest ticker over REST (called by the poller). */
  async refreshDerived(symbol: string): Promise<void> {
    try {
      const [ticker, funding, oi] = await Promise.all([
        fetchTicker(symbol, this.category),
        fetchFundingHistory(symbol, this.category, SEED_LIMIT),
        fetchOIHistory(symbol, this.category, SEED_LIMIT),
      ]);
      const st = this.states.get(symbol);
      if (!st) return;
      st.lastPrice = ticker.lastPrice;
      st.fundingRate = ticker.fundingRate;
      st.openInterest = ticker.openInterest;
      st.fundingHistory = funding;
      st.oiHistory = oi;
    } catch (err) {
      logger.warn(`[ws] derived refresh failed for ${symbol}: ${(err as Error).message}`);
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      const reconnect = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      logger.info(`[ws] connected ${this.url}${reconnect ? " (reconnect)" : ""}`);
      this.subscribe();
      this.startPing();
      // After a drop, patch any candles missed while we were offline.
      if (reconnect) void this.reseedStale();
    };

    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);

    ws.onerror = () => {
      // The close handler drives reconnect; just note it.
      logger.warn("[ws] socket error");
    };

    ws.onclose = () => {
      this.stopPing();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const backoff =
      Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.reconnectAttempts, 6)) +
      Math.floor(Math.random() * 250);
    logger.warn(`[ws] reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ op: "ping" }));
      } catch {
        // a failed send means the socket is gone; onclose will handle it
      }
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private subscribe(): void {
    const args: string[] = [];
    for (const s of this.symbols) {
      for (const tf of Object.values(BYBIT_INTERVAL)) args.push(`kline.${tf}.${s}`);
      args.push(`tickers.${s}`);
    }
    for (let i = 0; i < args.length; i += SUB_CHUNK) {
      const chunk = args.slice(i, i + SUB_CHUNK);
      try {
        this.ws?.send(JSON.stringify({ op: "subscribe", args: chunk }));
      } catch (err) {
        logger.warn(`[ws] subscribe failed: ${(err as Error).message}`);
      }
    }
  }

  /** Re-seed only symbols whose newest 1m candle is more than 2 intervals behind. */
  private async reseedStale(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const stale = this.symbols.filter((s) => {
      const st = this.states.get(s);
      return !st || intervalsBehind(st.candles1m, INTERVAL_SEC["1m"], nowSec) > 2;
    });
    if (stale.length === 0) return;
    logger.info(`[ws] re-seeding ${stale.length} stale symbols after reconnect`);
    await Promise.all(stale.map((s) => this.seedSymbol(s)));
  }

  // ── Message handling ──────────────────────────────────────────────────────────

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: BybitWsMessage;
    try {
      msg = JSON.parse(raw) as BybitWsMessage;
    } catch {
      return;
    }
    if (!msg.topic || !msg.data) return; // pong / subscribe ack / status frames

    if (msg.topic.startsWith("kline.")) this.onKline(msg);
    else if (msg.topic.startsWith("tickers.")) this.onTicker(msg);
  }

  private onKline(msg: BybitWsMessage): void {
    // topic: kline.{interval}.{symbol}
    const parts = msg.topic!.split(".");
    const tf = INTERVAL_TO_TF[parts[1] ?? ""];
    const symbol = parts[2];
    if (!tf || !symbol) return;
    const st = this.states.get(symbol);
    if (!st) return;

    const rows = msg.data as BybitKlineRow[];
    for (const row of rows) {
      const u: KlineUpdate = {
        time: Math.floor(Number(row.start) / 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        confirm: Boolean(row.confirm),
      };
      const key = `candles${tf}` as const;
      st[key] = applyKline(st[key], u, BUFFER_CAP);
    }
    st.lastKlineAt = Date.now();
  }

  private onTicker(msg: BybitWsMessage): void {
    const symbol = msg.topic!.split(".")[1];
    if (!symbol) return;
    const st = this.states.get(symbol);
    if (!st) return;
    // tickers arrive as a full snapshot then deltas carrying only changed fields,
    // so only overwrite what's present.
    const d = msg.data as BybitTicker;
    if (d.lastPrice !== undefined) st.lastPrice = Number(d.lastPrice);
    if (d.fundingRate !== undefined) st.fundingRate = Number(d.fundingRate);
    if (d.openInterest !== undefined) st.openInterest = Number(d.openInterest);
  }

  // ── Read side ─────────────────────────────────────────────────────────────────

  /** Build a MarketContext from current buffers. Matches the ContextProvider shape. */
  async getContext(symbol: string): Promise<MarketContext> {
    const st = this.states.get(symbol);
    if (!st) throw new Error(`[ws] no state for ${symbol} (not seeded)`);
    return {
      symbol,
      candles1m: st.candles1m,
      candles15m: st.candles15m,
      candles1h: st.candles1h,
      fundingRate: st.fundingRate,
      openInterest: st.openInterest,
      fundingHistory: st.fundingHistory,
      oiHistory: st.oiHistory,
      historyConfidence: 0.0,
    };
  }

  /** Latest streamed price, for the outcome tracker (avoids a REST ticker call). */
  lastPrice(symbol: string): number | null {
    return this.states.get(symbol)?.lastPrice ?? null;
  }

  /** Liveness snapshot for the health endpoint. */
  health(): { connected: boolean; symbols: Array<{ symbol: string; lastKlineAgoMs: number | null }> } {
    const now = Date.now();
    return {
      connected: this.ws?.readyState === 1,
      symbols: this.symbols.map((symbol) => {
        const at = this.states.get(symbol)?.lastKlineAt ?? 0;
        return { symbol, lastKlineAgoMs: at ? now - at : null };
      }),
    };
  }
}

// ── Minimal shapes for the Bybit WS frames we consume ─────────────────────────
interface BybitWsMessage {
  topic?: string;
  type?: string;
  data?: unknown;
}
interface BybitKlineRow {
  start: number | string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
  confirm: boolean;
}
interface BybitTicker {
  lastPrice?: string;
  fundingRate?: string;
  openInterest?: string;
}
