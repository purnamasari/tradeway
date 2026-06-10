// Alert delivery. Sends to Telegram when configured, otherwise prints to console.
// Supports optional chart image attachment (PNG buffer) and outcome notifications.
import type {
  Signal,
  OutcomeStatus,
  SignalUpdate,
  Direction,
  ManagementPlan,
  ManagementEvent,
  PathProbabilities,
  TradeAssessment,
} from "./types.js";
import { healthBand } from "./types.js";
import type { OutcomeRow } from "./db/accumulate.js";
import type { BybitPosition } from "./data/bybit-private.js";
import type { Env } from "./config.js";
import { logger } from "./logger.js";

export function formatExplainability(signal: Signal): string {
  const b = signal.score_breakdown;
  const lines: string[] = [];

  // Percentile extremes read as "top/bottom N%" — clamp to 1 so the 100th
  // percentile never renders as the nonsensical "top 0%".
  const topPct = (p: number) => Math.max(1, Math.round(100 - p));
  const bottomPct = (p: number) => Math.max(1, Math.round(p));

  if (b.funding_percentile <= 10) lines.push(`✓ Funding bottom ${bottomPct(b.funding_percentile)}% of 90d`);
  else if (b.funding_percentile >= 90) lines.push(`✓ Funding top ${topPct(b.funding_percentile)}% of 90d`);
  if (Math.abs(b.oi_zscore) >= 2.0) lines.push(`✓ OI z-score ${b.oi_zscore > 0 ? "+" : ""}${b.oi_zscore.toFixed(1)}`);
  if (b.volume_percentile >= 80) lines.push(`✓ Volume top ${topPct(b.volume_percentile)}% of recent`);

  // A zero-strength level is the absence of evidence — never a ✓ line.
  if (b.sr_level_strength > 0) lines.push(`✓ S/R strength ${b.sr_level_strength}`);
  if (b.engulf_body_ratio >= 1.0) lines.push(`✓ Engulf ratio ${b.engulf_body_ratio.toFixed(2)}×`);
  if (b.htf_aligned) lines.push(`✓ HTF 1H aligned`);
  if (b.sweep_wick_ratio) lines.push(`✓ Sweep wick ${b.sweep_wick_ratio.toFixed(2)}× body`);
  if (b.structure_intact) lines.push(`✓ Structure intact`);

  return lines.join("\n");
}

export function formatAlert(signal: Signal): string {
  const dir = signal.direction.toUpperCase();
  const emoji = signal.direction === "long" ? "🟢" : "🔴";
  const lines = [
    `🚨 ${signal.symbol} ${dir} · ${signal.strategy} ${emoji}`,
    ``,
    `Confidence:    ${signal.confidence} / 100`,
    `Setup Quality: ${signal.setup_quality} / 100`,
    `Entry: ${signal.entry_low} – ${signal.entry_high}`,
    `SL: ${signal.sl}   TP: ${signal.tp}   RR: 1:${signal.rr}`,
    `Regime: ${signal.regime} · Trend: ${signal.trend} (${signal.trend_source})`,
    ``,
    `Why?`,
    formatExplainability(signal),
  ];
  if (signal.paths) lines.push(``, formatPaths(signal.paths));
  if (signal.plan) lines.push(``, formatPlan(signal.plan));
  return lines.join("\n");
}

// ── Trade management formatting ───────────────────────────────────────────────

export function formatPaths(p: PathProbabilities): string {
  return [
    `Expected path:`,
    `A. TP directly — ${p.tp_direct}%`,
    `B. Retest, then TP — ${p.retest_then_tp}%`,
    `C. SL hit — ${p.sl_hit}%`,
  ].join("\n");
}

export function formatPlan(plan: ManagementPlan): string {
  const lines = [`Management plan:`];
  for (const r of plan.protection) lines.push(`• If ${r.trigger} → ${r.action}`);
  for (const r of plan.aggressive) lines.push(`• If ${r.trigger} → ${r.action}`);
  lines.push(`Emergency exit if:`);
  for (const r of plan.emergency) lines.push(`• ${r.trigger} → ${r.action}`);
  return lines.join("\n");
}

const HEALTH_LABEL: Record<string, string> = {
  excellent: "Excellent",
  healthy: "Healthy",
  neutral: "Neutral",
  weak: "Weak",
  exit_candidate: "Exit candidate",
};

const SEVERITY_EMOJI: Record<string, string> = { info: "ℹ", warning: "⚠", critical: "🚨" };

/**
 * Action-oriented management alert: every event answers what happened, why it
 * matters, and what the trader should do — never a bare observation.
 */
export function formatManagementEvent(
  symbol: string,
  direction: Direction,
  event: ManagementEvent,
  a: TradeAssessment,
): string {
  const lines = [
    `${SEVERITY_EMOJI[event.severity] ?? "⚠"} ${symbol} ${direction.toUpperCase()} — ${event.title}`,
    ``,
    `What happened:`,
    ...event.happened.map((h) => `• ${h}`),
    ``,
    `Why it matters:`,
    event.matters,
  ];
  if (event.actions.length > 0) {
    lines.push(``, `Suggested action:`);
    event.actions.forEach((act, idx) => lines.push(`${idx + 1}. ${act}`));
  }
  const conf =
    a.currentConfidence != null && a.entryConfidence != null
      ? ` · Confidence ${a.entryConfidence}→${a.currentConfidence}`
      : "";
  lines.push(
    ``,
    `Trade health: ${a.health.total}/100 (${HEALTH_LABEL[a.health.band]})${conf} · PnL ${signed(a.pnlPct)}%`,
  );
  return lines.join("\n");
}

/**
 * Living trade report — the full picture of a managed trade, edited into the
 * tracked message in place (quiet updates: one message per trade, refreshed).
 */
export function formatTradeReport(o: OutcomeRow, a: TradeAssessment): string {
  const dir = a.direction.toUpperCase();
  const emoji = a.health.total >= 70 ? "🟢" : a.health.total >= 40 ? "🟡" : "🔴";
  const managed = o.management_state === "MANAGED" ? " (managed)" : "";
  const lines = [
    `${emoji} ${a.symbol} ${dir} · ${o.source === "bybit" ? "Bybit" : o.strategy} — ${o.status}${managed}`,
    ``,
    `Trade Health: ${a.health.total}/100 (${HEALTH_LABEL[a.health.band]})`,
  ];
  const h = a.health.components;
  lines.push(
    `  Structure ${h.structure} · Momentum ${h.momentum} · Volume ${h.volume} · Trend ${h.trend_alignment} · Risk ${h.risk_protection}`,
  );
  if (a.currentConfidence != null && a.entryConfidence != null) {
    lines.push(`Confidence: ${a.entryConfidence} → ${a.currentConfidence}`);
  }
  lines.push(
    `Price: ${a.price} · PnL: ${signed(a.pnlPct)}%${a.pnlR != null ? ` (${signed(a.pnlR)}R)` : ""}`,
  );
  lines.push(`Entry: ${o.entry_price} · SL: ${o.sl || "—"} · TP: ${o.tp || "—"}`);

  if (a.observations.length > 0) {
    lines.push(``);
    for (const ob of a.observations) lines.push(`✓ ${ob}`);
  }
  if (a.warnings.length > 0) {
    if (a.observations.length === 0) lines.push(``);
    for (const w of a.warnings) lines.push(`⚠ ${w}`);
  }

  if (a.actions.length > 0) {
    lines.push(``, `Suggested actions:`);
    a.actions.forEach((act, idx) => lines.push(`${idx + 1}. ${act}`));
  }

  if (a.paths) {
    lines.push(
      ``,
      `Path → TP direct ${a.paths.tp_direct}% · retest first ${a.paths.retest_then_tp}% · SL ${a.paths.sl_hit}%`,
    );
  }

  if (a.emergency.length > 0) {
    lines.push(``, `Exit immediately if:`);
    for (const e of a.emergency) lines.push(`• ${e}`);
  }

  lines.push(``, `Updated ${hhmm(new Date())}`);
  return lines.join("\n");
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

// ── Signal update formatting (edge lifecycle) ───────────────────────────────

const FUNDING_PCTILE_NOTIFY_DELTA = 3; // show Funding line only if it moved >= this
const OI_Z_NOTIFY_DELTA = 0.3; // show OI line only if it moved >= this

function fmtZ(n: number): string {
  return n.toFixed(1);
}

/**
 * Format an edge-lifecycle update — sent instead of a duplicate signal when a
 * symbol already has an active signal whose edge has shifted.
 */
export function formatSignalUpdate(u: SignalUpdate): string {
  const dir = u.direction.toUpperCase();
  const invalid = u.edgeState === "INVALIDATED";
  const lines: string[] = [
    invalid ? `⚠ ${u.symbol} ${dir} INVALIDATED` : `⚠ ${u.symbol} ${dir} UPDATE`,
    ``,
  ];

  if (invalid) {
    if (u.reasons.length) {
      lines.push(`Reason:`);
      for (const r of u.reasons) lines.push(`- ${r}`);
      lines.push(``);
    }
    lines.push(`Confidence: ${u.original.confidence} → ${u.live.confidence}`);
    return lines.join("\n");
  }

  lines.push(`Status: ${u.edgeState}`, ``);
  lines.push(`Confidence: ${u.original.confidence} → ${u.live.confidence}`);
  if (Math.abs(u.live.funding_percentile - u.original.funding_percentile) >= FUNDING_PCTILE_NOTIFY_DELTA) {
    lines.push(`Funding: ${Math.round(u.original.funding_percentile)}% → ${Math.round(u.live.funding_percentile)}%`);
  }
  if (Math.abs(u.live.oi_zscore - u.original.oi_zscore) >= OI_Z_NOTIFY_DELTA) {
    lines.push(`OI Z-score: ${fmtZ(u.original.oi_zscore)} → ${fmtZ(u.live.oi_zscore)}`);
  }
  lines.push(``);
  lines.push(u.edgeState === "EDGE_WEAKENING" ? `Edge weakening — monitor closely.` : `Trade remains valid.`);
  return lines.join("\n");
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Living status for a tracked signal — used to EDIT the original alert message in
 * place on each edge change (instead of sending a new message). One message tracks
 * the trade's whole life: state, confidence drift, levels, and the latest reasons.
 */
export function formatSignalStatus(o: OutcomeRow, u: SignalUpdate): string {
  const dir = u.direction.toUpperCase();
  const emoji =
    u.edgeState === "INVALIDATED" ? "⛔" : u.edgeState === "EDGE_WEAKENING" ? "⚠" : "✅";
  const lines = [
    `${emoji} ${u.symbol} ${dir} · ${u.strategy} — ${u.edgeState}`,
    ``,
    `Confidence: ${u.original.confidence} → ${u.live.confidence}`,
    `Entry: ${o.entry_low}–${o.entry_high} · SL: ${o.sl} · TP: ${o.tp}`,
  ];
  if (u.reasons.length) {
    lines.push(``);
    for (const r of u.reasons) lines.push(`• ${r}`);
  }
  lines.push(``, `Updated ${hhmm(new Date())}`);
  return lines.join("\n");
}

// ── Outcome formatting ──────────────────────────────────────────────────────

const OUTCOME_EMOJI: Record<string, string> = {
  TP_HIT: "✅",
  SL_HIT: "❌",
  EXPIRED: "⏰",
  CLOSED: "🏁", // real Bybit position closed on the exchange
};

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatPricePct(entry: number, exit: number, direction: string): string {
  const pct = direction === "long"
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Realized R-multiple vs the initial risk |entry − SL|; null when SL is unset
 *  (Bybit positions without a stop use a 0 sentinel). */
function realizedR(entry: number, exit: number, sl: number, direction: string): number | null {
  const risk = Math.abs(entry - sl);
  // Negated comparisons so NaN (malformed row) also bails out.
  if (!(sl > 0) || !(risk > 0)) return null;
  const move = direction === "long" ? exit - entry : entry - exit;
  return move / risk;
}

/** " (+1.4R)" suffix, or empty when R is not computable. */
function rSuffix(entry: number, exit: number, sl: number, direction: string): string {
  const r = realizedR(entry, exit, sl, direction);
  return r == null ? "" : ` (${r >= 0 ? "+" : ""}${r.toFixed(1)}R)`;
}

export function formatOutcome(
  outcome: OutcomeRow,
  status: OutcomeStatus,
  hitPrice: number | null,
  closedAt: Date,
): string {
  const emoji = OUTCOME_EMOJI[status] ?? "📊";
  const dir = outcome.direction.toUpperCase();
  const duration = formatDuration(closedAt.getTime() - new Date(outcome.opened_at).getTime());
  const pctStr = hitPrice !== null
    ? ` · ${formatPricePct(outcome.entry_price, hitPrice, outcome.direction)}` +
      rSuffix(outcome.entry_price, hitPrice, outcome.sl, outcome.direction)
    : "";

  return [
    `${emoji} ${outcome.symbol} ${dir} · ${status.replace("_", " ")}${pctStr}`,
    `Strategy: ${outcome.strategy} · Duration: ${duration}`,
    `Entry: ${outcome.entry_price}`,
    hitPrice !== null ? `Exit: ${hitPrice}` : null,
    `SL: ${outcome.sl}   TP: ${outcome.tp}`,
  ].filter(Boolean).join("\n");
}

// ── Telegram message-size limits ─────────────────────────────────────────────
// Photo captions cap at 1024 chars; text messages at 4096. The enriched signal
// alert (core + expected paths + management plan) can exceed the caption limit,
// which would make sendPhoto fail and silently degrade to a text-only alert —
// losing the chart. Instead we split at the plan boundary and deliver the plan
// as a reply to the chart message.
export const TG_CAPTION_LIMIT = 1024;
export const TG_TEXT_LIMIT = 4096;

const PLAN_MARKER = "\nManagement plan:";

/**
 * Split an alert into [caption, overflow] when it exceeds the photo-caption
 * limit. Prefers a clean cut at the management-plan boundary; falls back to a
 * hard ellipsis truncation when no marker fits.
 */
export function splitCaption(text: string): [string, string | null] {
  if (text.length <= TG_CAPTION_LIMIT) return [text, null];
  const idx = text.indexOf(PLAN_MARKER);
  if (idx > 0 && idx <= TG_CAPTION_LIMIT) {
    return [text.slice(0, idx).trimEnd(), text.slice(idx + 1)];
  }
  return [text.slice(0, TG_CAPTION_LIMIT - 1) + "…", null];
}

/** Clamp a message to the channel's hard limit (caption vs text edit). */
export function clampMessage(text: string, isPhoto: boolean): string {
  const limit = isPhoto ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT;
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}

// ── Notifier interface ──────────────────────────────────────────────────────

/**
 * A /scan reply: the decision briefing, plus the setup chart when a candidate
 * setup was detected this pass (gated, cooling down, or already tracking — when
 * the signal passes gates the alert itself carries the chart instead). No setup
 * means no chart: text only.
 */
export interface ScanReply {
  text: string;
  chart?: Buffer | null;
}

/** Options for an outgoing signal alert. */
export interface SendOptions {
  /** DB id of the recorded signal — embedded in Follow/Skip callback data. */
  signalId?: number;
  /** Attach Follow/Skip buttons (interactive notifiers only). */
  followable?: boolean;
}

/** Result of sending a message — the id to edit later, and whether it's a photo
 *  (caption-edit) or text (text-edit). messageId is null on non-interactive channels. */
export interface SendResult {
  messageId: number | null;
  isPhoto: boolean;
}

export interface Notifier {
  /** True if the channel supports inbound interaction (buttons/commands). */
  readonly interactive: boolean;
  send(signal: Signal, chartPng?: Buffer | null, opts?: SendOptions): Promise<SendResult>;
  sendOutcome(
    outcome: OutcomeRow,
    status: OutcomeStatus,
    hitPrice: number | null,
    closedAt: Date,
  ): Promise<void>;
  /** Edge-lifecycle update for an already-active signal (not a new signal). */
  sendSignalUpdate(update: SignalUpdate): Promise<void>;
  /** Action-oriented trade-management alert (pre-formatted event message).
   *  `outcomeId` attaches a 🔎 Details button (interactive channels) that pulls
   *  the full trade report via the existing /running Details handler. */
  sendManagement(text: string, opts?: { outcomeId?: number }): Promise<void>;
  /** Notify that a real Bybit position was autodetected and is now tracked. */
  sendPositionTracked(position: BybitPosition, direction: Direction): Promise<SendResult>;
  /**
   * Edit a previously sent message in place (the anti-spam path: refresh the same
   * message instead of posting a new one). No-op if the channel can't edit. Swallows
   * Telegram's "message is not modified" so an unchanged refresh is harmless.
   */
  editMessage(messageId: number, isPhoto: boolean, text: string): Promise<void>;
  /** Pre-formatted analytics digest (scheduled performance summary). */
  sendDigest(text: string): Promise<void>;
  /**
   * Operational/monitoring message (startup, shutdown, crash) — not a trading
   * signal. Never throws: a failure to deliver an ops alert must not take down
   * the process it is trying to report on.
   */
  sendOps(text: string): Promise<void>;
  /**
   * Begin listening for inbound chat commands (Telegram long-polling). No-op for
   * the console notifier. Safe to call once, in loop mode only.
   */
  startCommands(handlers: CommandHandlers): void;
  /** Stop the inbound command listener (graceful shutdown). */
  stopCommands(): Promise<void>;
}

/** Callbacks the command listener invokes to build replies — keeps notify.ts free
 *  of db/analytics imports. Each returns a ready-to-send message string. */
export interface CommandHandlers {
  /** `/analytics [days]` — performance report (digest). */
  analytics: (days?: number) => Promise<string>;
  /** `/status` — current open signals. */
  status: () => Promise<string>;
  /** `/running` — interactive list of everything tracked, with Details buttons. */
  running: () => Promise<RunningView>;
  /** Details button / trade-card view switches — the tracked row by outcome id.
   *  The notifier renders the requested view from it (formatTradeView). */
  getOutcome: (outcomeId: number) => Promise<OutcomeRow | null>;
  /** `/scan SYMBOL` — force a scan; returns a decision briefing, with the setup
   *  chart attached when a candidate setup was detected. The handler normalizes
   *  tickers (zec → ZECUSDT), so any coin name works. */
  scan: (symbol: string) => Promise<ScanReply>;
  /** `/scan` with no args (or `all`) — scan every enabled watchlist symbol. */
  scanAll: () => Promise<string>;
  /** `/recent` evaluation card — the last `limit` closed trades, newest first.
   *  The notifier renders the requested view from them (root/list/performance). */
  recentClosed: (limit: number) => Promise<OutcomeRow[]>;
  /** Follow button — activate (track) the signal; returns a confirmation. */
  onFollow: (signalId: number) => Promise<string>;
  /** Skip button — dismiss/shadow the signal; returns a confirmation. */
  onSkip: (signalId: number) => Promise<string>;
}

// ── Open-signals status formatting (for /status) ────────────────────────────

/** Compact health/PnL suffix for list views (from persisted manager fields). */
function healthSuffix(o: OutcomeRow): string {
  if (o.trade_health == null) return "";
  const pnl = o.management_snapshot?.pnl_pct;
  const pnlStr = pnl != null ? ` · ${pnl >= 0 ? "+" : ""}${pnl}%` : "";
  return ` · ❤ ${o.trade_health}${pnlStr}`;
}

export function formatStatus(rows: OutcomeRow[]): string {
  if (rows.length === 0) return "📡 No open signals.";
  const lines = [`📡 Open signals (${rows.length}):`, ""];
  for (const o of rows) {
    const conf =
      o.live_confidence != null
        ? `${o.original_confidence ?? "?"}→${o.live_confidence}`
        : `${o.original_confidence ?? "?"}`;
    lines.push(`${o.symbol} ${o.direction.toUpperCase()} · ${o.strategy}`);
    lines.push(`  ${o.status} · edge ${o.edge_state} · conf ${conf}${healthSuffix(o)}`);
  }
  return lines.join("\n");
}

// ── Position-tracked notification (autodetected Bybit position) ──────────────

export function formatPositionTracked(p: BybitPosition, direction: Direction): string {
  const lines = [
    `📍 Tracking your ${p.symbol} ${direction.toUpperCase()} position`,
    ``,
    `Entry: ${p.avgPrice} · Size: ${p.size}`,
  ];
  if (p.stopLoss) lines.push(`SL: ${p.stopLoss}`);
  if (p.takeProfit) lines.push(`TP: ${p.takeProfit}`);
  lines.push(``, `Source: Bybit (auto-detected) — I'll report when you close it.`);
  return lines.join("\n");
}

/**
 * Live status for a tracked Bybit position — edited into the SAME message on each
 * reconcile pass so there is one self-updating message per position, not a stream.
 */
export function formatPositionLive(
  o: OutcomeRow,
  markPrice: number | null,
  unrealisedPnl: number | null,
): string {
  const dir = o.direction.toUpperCase();
  const lines = [
    `📍 ${o.symbol} ${dir} · Bybit (live)`,
    ``,
    `Entry: ${o.entry_price} · Size: ${o.original_factors?.size ?? "?"}`,
  ];
  if (markPrice != null) {
    lines.push(`Mark: ${markPrice} · PnL: ${formatPricePct(o.entry_price, markPrice, o.direction)}`);
  }
  if (unrealisedPnl != null) lines.push(`uPnL: ${unrealisedPnl}`);
  if (o.sl) lines.push(`SL: ${o.sl}`);
  if (o.tp) lines.push(`TP: ${o.tp}`);
  // Latest manager read, when the trade manager has scanned this position.
  if (o.trade_health != null) {
    lines.push(`Trade health: ${o.trade_health}/100 (${HEALTH_LABEL[healthBand(o.trade_health)]})`);
  }
  if (o.suggested_stop != null) {
    lines.push(`Suggested stop: ${o.suggested_stop} (${o.suggested_stop_method ?? "adaptive"})`);
  }
  lines.push(``, `Updated ${hhmm(new Date())} · closes when you exit on Bybit`);
  return lines.join("\n");
}

// ── Interactive evaluation card (/recent) ────────────────────────────────────
// One message, four views, navigated with inline buttons that edit it in place:
//   root (streak, net R, WR, $ PnL, best/worst)
//     → 📋 View Trades  (numbered list + a button per trade)
//         → one closed trade (result, $, levels, duration → 🧠 Analysis)
//     → 📊 Performance  (net R over last 10/30/90, profit factor, expectancy)
// Rows arrive newest-first (fetchRecentClosedOutcomes).

export type RecentView = "root" | "list" | "perf";

/** Realized result of one closed trade, derived from the recorded exit. */
interface ClosedPnl {
  pct: number;
  r: number | null; // null when no usable SL (initial risk unknown)
  usd: number | null; // null when position size is unknown (signal trades)
}

function closedPnl(o: OutcomeRow): ClosedPnl | null {
  if (o.hit_price == null || !(o.entry_price > 0)) return null;
  const pct =
    o.direction === "long"
      ? ((o.hit_price - o.entry_price) / o.entry_price) * 100
      : ((o.entry_price - o.hit_price) / o.entry_price) * 100;
  const r = realizedR(o.entry_price, o.hit_price, o.sl, o.direction);
  const size = o.original_factors?.size;
  const usd = size != null ? (pct / 100) * o.entry_price * size : null;
  return { pct, r, usd };
}

/** "ZECUSDT" → "ZEC" for compact list lines (mirrors the resolver's suffixes). */
export function coinName(symbol: string): string {
  const base = symbol.replace(/(USDT|USDC|PERP|USD)$/, "");
  return base || symbol;
}

function fmtR(r: number): string {
  return `${r >= 0 ? "+" : ""}${r.toFixed(1)}R`;
}

function fmtUsd(usd: number): string {
  return `${usd >= 0 ? "+" : "-"}$${Math.abs(usd).toFixed(2)}`;
}

function resultEmoji(p: ClosedPnl | null): string {
  if (!p) return "⚪";
  return p.pct > 0 ? "🟢" : p.pct < 0 ? "🔴" : "⚪";
}

/** Compact result tag: R when known, else %. */
function resultTag(p: ClosedPnl): string {
  return p.r != null ? fmtR(p.r) : signedPct(p.pct);
}

/** Root view — the 5-second scoreboard for the last N trades. HTML-formatted. */
export function formatRecentRoot(rows: OutcomeRow[]): string {
  if (rows.length === 0) return "📒 No closed trades yet.";
  const realized = rows
    .map((o) => ({ o, p: closedPnl(o) }))
    .filter((x): x is { o: OutcomeRow; p: ClosedPnl } => x.p !== null);

  const lines = [`<b>📒 Last ${rows.length} Trades</b>`, ``];

  if (realized.length === 0) {
    lines.push(`No realized results yet (all expired before entry).`);
    return lines.join("\n");
  }

  // Last-5 form, newest first — one glance answers "how's it going lately".
  const streak = realized.slice(0, 5).map((x) => resultEmoji(x.p)).join("");
  lines.push(`<b>Current Streak:</b>`, streak, ``);

  const withR = realized.filter((x) => x.p.r != null);
  if (withR.length > 0) {
    const netR = withR.reduce((s, x) => s + x.p.r!, 0);
    lines.push(`Net: <b>${fmtR(netR)}</b> ${netR >= 0 ? "🟢" : "🔴"}`);
  }
  const wins = realized.filter((x) => x.p.pct > 0).length;
  const losses = realized.filter((x) => x.p.pct < 0).length;
  if (wins + losses > 0) {
    lines.push(`WR: <b>${Math.round((wins / (wins + losses)) * 100)}%</b>`);
  }
  const withUsd = realized.filter((x) => x.p.usd != null);
  const avgPct = realized.reduce((s, x) => s + x.p.pct, 0) / realized.length;
  const usdPart = withUsd.length > 0 ? `<b>${fmtUsd(withUsd.reduce((s, x) => s + x.p.usd!, 0))}</b> ` : "";
  lines.push(`PnL: ${usdPart}(${signedPct(avgPct)})`);

  // Best/worst by R when available, else by %.
  const score = (x: { p: ClosedPnl }) => x.p.r ?? x.p.pct;
  const sorted = [...realized].sort((a, b) => score(b) - score(a));
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  lines.push(
    ``,
    `<b>Best:</b>`,
    `${resultEmoji(best.p)} ${coinName(best.o.symbol)} <b>${resultTag(best.p)}</b>`,
    ``,
    `<b>Worst:</b>`,
    `${resultEmoji(worst.p)} ${coinName(worst.o.symbol)} <b>${resultTag(worst.p)}</b>`,
  );
  return lines.join("\n");
}

/** Trades list view — numbered so the buttons below map 1:1. HTML-formatted. */
export function formatRecentList(rows: OutcomeRow[]): string {
  if (rows.length === 0) return "📒 No closed trades yet.";
  const lines = [`<b>📒 Recent Trades</b>`, ``];
  rows.forEach((o, i) => {
    const p = closedPnl(o);
    const res = p ? resultTag(p) : o.status.replace("_", " ");
    lines.push(`${i + 1}. ${resultEmoji(p)} ${coinName(o.symbol)} ${o.direction.toUpperCase()} <b>${res}</b>`);
  });
  return lines.join("\n");
}

/** One closed trade — the result card behind a list button.
 *  Minimal: R + $ + duration. Entry/exit/levels live in the 🧠 Analysis view.
 *  HTML-formatted. */
export function formatRecentTrade(o: OutcomeRow): string {
  const p = closedPnl(o);
  const dir = o.direction.toUpperCase();
  const lines = [`<u><b>${resultEmoji(p)} ${o.symbol} ${dir}</b></u>`, ``];

  if (p) {
    if (p.r != null) lines.push(`<b>${fmtR(p.r)}</b>`);
    else lines.push(`<b>${signedPct(p.pct)}</b>`);
    if (p.usd != null) lines.push(fmtUsd(p.usd));
    lines.push(``);
  }

  const dur = o.duration_ms != null ? formatDuration(o.duration_ms) : null;
  if (dur) lines.push(`Duration: <b>${dur}</b>`);
  return lines.join("\n");
}

/** Performance view — risk-normalized stats over the last up-to-90 trades.
 *  Uses label-colon / value-on-next-line layout. HTML-formatted. */
export function formatRecentPerformance(rows: OutcomeRow[]): string {
  const realized = rows
    .map((o) => ({ o, p: closedPnl(o) }))
    .filter((x): x is { o: OutcomeRow; p: ClosedPnl } => x.p !== null);
  if (realized.length === 0) return "📊 No realized trades to evaluate yet.";

  const lines = [`<b>📊 Performance</b>`, ``];

  // Net R windows (rows newest-first). Windows beyond history collapse to the
  // last available window and the loop stops to avoid duplicates.
  const netR = (k: number) => realized.slice(0, k).reduce((s, x) => s + (x.p.r ?? 0), 0);
  for (const k of [10, 30, 90]) {
    const window = Math.min(k, realized.length);
    lines.push(`<b>Last ${window}:</b>`, `<b>${fmtR(netR(k))}</b>`, ``);
    if (realized.length <= k) break;
  }

  const wins = realized.filter((x) => x.p.pct > 0);
  const losses = realized.filter((x) => x.p.pct < 0);
  if (wins.length + losses.length > 0) {
    lines.push(
      `<b>Win Rate:</b>`,
      `<b>${Math.round((wins.length / (wins.length + losses.length)) * 100)}%</b>`,
      ``,
    );
  }

  const rWins = realized.filter((x) => (x.p.r ?? 0) > 0);
  const rLosses = realized.filter((x) => (x.p.r ?? 0) < 0);
  const grossWin = rWins.reduce((s, x) => s + x.p.r!, 0);
  const grossLoss = Math.abs(rLosses.reduce((s, x) => s + x.p.r!, 0));
  if (grossWin > 0 && grossLoss > 0) {
    lines.push(`<b>Profit Factor:</b>`, `<b>${(grossWin / grossLoss).toFixed(2)}</b>`, ``);
  }
  const withR = realized.filter((x) => x.p.r != null);
  if (withR.length > 0) {
    const expectancy = withR.reduce((s, x) => s + x.p.r!, 0) / withR.length;
    lines.push(`<b>Expectancy:</b>`, `<b>${fmtR(expectancy)}</b> / trade`, ``);
  }
  if (rWins.length > 0) lines.push(`<b>Avg Win:</b>`, `<b>${fmtR(grossWin / rWins.length)}</b>`, ``);
  if (rLosses.length > 0) lines.push(`<b>Avg Loss:</b>`, `<b>${fmtR(-grossLoss / rLosses.length)}</b>`);

  return lines.join("\n");
}

// ── Interactive /running view ────────────────────────────────────────────────

/** A `/running` reply: a text body plus the trades to render as Details buttons. */
export interface RunningView {
  text: string;
  trades: { id: number; label: string }[];
}

function tradeSourceTag(o: OutcomeRow): string {
  return o.source === "bybit" ? "Bybit" : o.strategy;
}

/** Build the /running list + the per-trade button labels. */
export function formatRunning(rows: OutcomeRow[]): RunningView {
  if (rows.length === 0) return { text: "📡 Nothing running.", trades: [] };
  const lines = [`📡 Running (${rows.length}):`, ""];
  const trades: { id: number; label: string }[] = [];
  for (const o of rows) {
    const dir = o.direction.toUpperCase();
    lines.push(`#${o.id} ${o.symbol} ${dir} · ${tradeSourceTag(o)}`);
    if (o.source === "bybit") {
      lines.push(`  ${o.status} · entry ${o.entry_price}${healthSuffix(o)}`);
    } else {
      const conf =
        o.live_confidence != null
          ? `${o.original_confidence ?? "?"}→${o.live_confidence}`
          : `${o.original_confidence ?? "?"}`;
      lines.push(`  ${o.status} · edge ${o.edge_state} · conf ${conf}${healthSuffix(o)}`);
    }
    trades.push({ id: o.id, label: `🔎 #${o.id} ${o.symbol}` });
  }
  return { text: lines.join("\n"), trades };
}

// ── Interactive trade card (Details button) ──────────────────────────────────
// One message, four views. The Details press shows a 5-second summary with
// section buttons ([📋 Action] [📊 Analysis] [🛡 Risk]); pressing a section
// EDITS the same message in place (no scroll, no new messages), and every
// sub-view carries the sibling tabs plus ⬅ Back to the summary. All views
// render from the persisted row alone — no market recompute.

export type TradeView = "summary" | "action" | "analysis" | "risk";

const VIEW_LABEL: Record<Exclude<TradeView, "summary">, string> = {
  action: "📋 Action",
  analysis: "📊 Analysis",
  risk: "🛡 Risk",
};

function signedPct(n: number, dp = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

/** One-glance verdict line: what should the user do with this trade right now. */
function tradeVerdict(o: OutcomeRow): string {
  if (o.status === "PENDING_ENTRY") return "⏳ WAITING ENTRY";
  if (o.status !== "ACTIVE") return `${OUTCOME_EMOJI[o.status] ?? "📊"} ${o.status.replace("_", " ")}`;
  const h = o.trade_health;
  if (h == null) return "👀 MONITORING";
  if (h < 40) return "🔴 EXIT";
  if (h < 55) return "🟠 REDUCE";
  return "🟢 HOLD";
}

/** Header shared by every view so the user never loses context mid-switch. */
function tradeCardHeader(o: OutcomeRow, view: TradeView): string {
  const where = `#${o.id} ${o.symbol} ${o.direction.toUpperCase()} · ${tradeSourceTag(o)}`;
  return view === "summary" ? `${tradeVerdict(o)} · ${where}` : `${VIEW_LABEL[view]} · ${where}`;
}

/** The 5-second read: verdict, PnL, confidence, levels, expected path. */
function formatTradeViewSummary(o: OutcomeRow): string {
  const lines = [tradeCardHeader(o, "summary"), ``];

  const snap = o.management_snapshot;
  if (snap) {
    let pnl = `PnL: ${signedPct(snap.pnl_pct)}`;
    const size = o.original_factors?.size;
    if (size != null && o.entry_price > 0) {
      const usd = (snap.pnl_pct / 100) * o.entry_price * size;
      pnl += ` (${usd >= 0 ? "+" : "-"}$${Math.abs(usd).toFixed(2)})`;
    } else if (snap.pnl_r != null) {
      pnl += ` (${snap.pnl_r >= 0 ? "+" : ""}${snap.pnl_r}R)`;
    }
    lines.push(pnl);
  }
  const conf = o.live_confidence ?? o.trade_health;
  if (conf != null) lines.push(`Confidence: ${conf}%`);
  if (lines.length > 2) lines.push(``);

  // Current stop → suggested stop, when the manager found a better one.
  const slBase = o.sl > 0 ? String(o.sl) : "—";
  lines.push(
    o.suggested_stop != null && o.suggested_stop !== o.sl
      ? `SL: ${slBase} → ${o.suggested_stop}`
      : `SL: ${slBase}`,
  );
  lines.push(`TP: ${o.tp > 0 ? o.tp : "—"}`);

  if (o.path_probs) {
    const p = o.path_probs;
    lines.push(
      ``,
      `Path:`,
      `🎯 TP Direct: ${p.tp_direct}%`,
      `🔄 Retest First: ${p.retest_then_tp}%`,
      `❌ SL: ${p.sl_hit}%`,
    );
  }
  return lines.join("\n");
}

/** What to do: the manager's ordered suggestions + live exit conditions. */
function formatTradeViewAction(o: OutcomeRow): string {
  const lines = [tradeCardHeader(o, "action"), ``];
  const snap = o.management_snapshot;

  const actions = snap?.actions ?? [];
  if (actions.length > 0) {
    lines.push(`Recommended:`);
    actions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  } else if (o.suggested_stop != null) {
    lines.push(`Recommended:`, `1. Move SL → ${o.suggested_stop} (${o.suggested_stop_method ?? "adaptive"})`);
  } else {
    lines.push(`No action needed — let it run.`);
  }

  // Live emergency conditions; fall back to the plan's triggers from detection time.
  const emergency =
    snap?.emergency && snap.emergency.length > 0
      ? snap.emergency
      : (o.management_plan?.emergency.map((r) => r.trigger) ?? []);
  if (emergency.length > 0) {
    lines.push(``, `Exit if:`);
    for (const e of emergency) lines.push(`• ${e}`);
  }
  return lines.join("\n");
}

/** Why: health component scores plus the manager's observations and warnings. */
function formatTradeViewAnalysis(o: OutcomeRow): string {
  const lines = [tradeCardHeader(o, "analysis"), ``];
  const h = o.health_components;
  if (h) {
    lines.push(
      `Structure: ${h.structure}`,
      `Momentum: ${h.momentum}`,
      `Volume: ${h.volume}`,
      `Trend: ${h.trend_alignment}`,
      `Risk: ${h.risk_protection}`,
    );
  }
  if (o.live_confidence != null && o.original_confidence != null) {
    lines.push(``, `Confidence: ${o.original_confidence} → ${o.live_confidence} (edge ${o.edge_state})`);
  }

  const snap = o.management_snapshot;
  if (snap) {
    if (snap.observations.length > 0) {
      lines.push(``);
      for (const ob of snap.observations) lines.push(`✓ ${ob}`);
    }
    if (snap.warnings.length > 0) {
      lines.push(``);
      for (const w of snap.warnings) lines.push(`⚠ ${w}`);
    }
  }
  if (!h && !snap) {
    lines.push(`Manager hasn't assessed this trade yet — it scans every minute.`);
  }
  return lines.join("\n");
}

const RISK_LEVEL: Record<string, string> = {
  excellent: "Low",
  healthy: "Low",
  neutral: "Medium",
  weak: "High",
  exit_candidate: "Critical",
};

/** Exposure: remaining RR from the current price, risk level, weakest factor. */
function formatTradeViewRisk(o: OutcomeRow): string {
  const lines = [tradeCardHeader(o, "risk"), ``];

  const price = o.management_snapshot?.price ?? o.entry_price;
  if (o.sl > 0 && o.tp > 0 && price > 0) {
    const reward = Math.abs(o.tp - price);
    const risk = Math.abs(price - o.sl);
    if (risk > 0) lines.push(`Current RR: ${(reward / risk).toFixed(1)}`);
    lines.push(`Stop distance: ${((risk / price) * 100).toFixed(2)}%`);
  } else if (!(o.sl > 0)) {
    lines.push(`⚠ No stop set — unbounded risk.`);
  }

  if (o.trade_health != null) {
    const band = healthBand(o.trade_health);
    lines.push(``, `Risk: ${RISK_LEVEL[band] ?? "Medium"}`, `Trade Health: ${o.trade_health}/100 (${HEALTH_LABEL[band]})`);
    const h = o.health_components;
    if (h) {
      const factors: Array<[string, number]> = [
        ["Structure", h.structure],
        ["Momentum", h.momentum],
        ["Volume", h.volume],
        ["Trend", h.trend_alignment],
        ["Risk protection", h.risk_protection],
      ];
      factors.sort((a, b) => a[1] - b[1]);
      const [name, value] = factors[0]!;
      lines.push(``, `Weakest factor: ${name} (${value})`);
    }
  }
  return lines.join("\n");
}

/** Render one view of the interactive trade card. */
export function formatTradeView(view: TradeView, o: OutcomeRow): string {
  switch (view) {
    case "action":
      return formatTradeViewAction(o);
    case "analysis":
      return formatTradeViewAnalysis(o);
    case "risk":
      return formatTradeViewRisk(o);
    default:
      return formatTradeViewSummary(o);
  }
}

class ConsoleNotifier implements Notifier {
  readonly interactive = false;

  async send(signal: Signal, chartPng?: Buffer | null): Promise<SendResult> {
    console.log("\n" + "─".repeat(48));
    console.log(formatAlert(signal));
    if (chartPng) {
      console.log(`[chart: ${chartPng.byteLength} bytes PNG attached]`);
    }
    console.log("─".repeat(48) + "\n");
    return { messageId: null, isPhoto: false };
  }

  async sendOutcome(
    outcome: OutcomeRow,
    status: OutcomeStatus,
    hitPrice: number | null,
    closedAt: Date,
  ): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(formatOutcome(outcome, status, hitPrice, closedAt));
    console.log("─".repeat(48) + "\n");
  }

  async sendSignalUpdate(update: SignalUpdate): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(formatSignalUpdate(update));
    console.log("─".repeat(48) + "\n");
  }

  async sendManagement(text: string, _opts?: { outcomeId?: number }): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(text);
    console.log("─".repeat(48) + "\n");
  }

  async sendPositionTracked(position: BybitPosition, direction: Direction): Promise<SendResult> {
    console.log("\n" + "─".repeat(48));
    console.log(formatPositionTracked(position, direction));
    console.log("─".repeat(48) + "\n");
    return { messageId: null, isPhoto: false };
  }

  async editMessage(_messageId: number, _isPhoto: boolean, text: string): Promise<void> {
    // No message ids on the console — just print the refreshed content.
    console.log("\n" + "─".repeat(48));
    console.log(text);
    console.log("─".repeat(48) + "\n");
  }

  async sendDigest(text: string): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(text);
    console.log("─".repeat(48) + "\n");
  }

  async sendOps(text: string): Promise<void> {
    logger.info(`[ops] ${text}`);
  }

  startCommands(): void {
    logger.debug("[notify] console notifier — inbound commands unavailable");
  }

  async stopCommands(): Promise<void> {
    // no-op
  }
}

class TelegramNotifier implements Notifier {
  readonly interactive = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private bot: any, private chatId: string) {}

  /** Build the Follow/Skip inline keyboard for a followable signal, else undefined. */
  private async followKeyboard(opts?: SendOptions) {
    if (!opts?.followable || opts.signalId == null) return undefined;
    const { InlineKeyboard } = await import("grammy");
    return new InlineKeyboard()
      .text("✅ Follow", `follow:${opts.signalId}`)
      .text("⏭ Skip", `skip:${opts.signalId}`);
  }

  /** Inline keyboard of Details buttons for the /running list (one row per trade). */
  private async detailsKeyboard(trades: { id: number; label: string }[]) {
    if (trades.length === 0) return undefined;
    const { InlineKeyboard } = await import("grammy");
    const kb = new InlineKeyboard();
    for (const t of trades) kb.text(t.label, `details:${t.id}`).row();
    return kb;
  }

  /** Navigation for the /recent evaluation card. The list view gets one button
   *  per trade (two per row), labeled to match its numbered lines. */
  private async recentKeyboard(view: RecentView, n: number, rows?: OutcomeRow[]) {
    const { InlineKeyboard } = await import("grammy");
    const kb = new InlineKeyboard();
    if (view === "root") {
      kb.text("📋 View Trades", `rc:list:${n}`).text("📊 Performance", `rc:perf:${n}`);
    } else if (view === "list") {
      const listed = rows ?? [];
      listed.forEach((o, i) => {
        kb.text(`#${i + 1} ${coinName(o.symbol)}`, `rc:trade:${o.id}:${n}`);
        if (i % 2 === 1) kb.row();
      });
      if (listed.length % 2 === 1) kb.row();
      kb.text("⬅ Back", `rc:root:${n}`);
    } else {
      kb.text("⬅ Back", `rc:root:${n}`);
    }
    return kb;
  }

  /** Navigation for the interactive trade card: the summary offers the three
   *  sections; a section offers its siblings plus ⬅ Back. Pressing any of these
   *  edits the SAME message in place — one card, no scroll. */
  private async tradeViewKeyboard(outcomeId: number, view: TradeView) {
    const { InlineKeyboard } = await import("grammy");
    const kb = new InlineKeyboard();
    const sections: Array<Exclude<TradeView, "summary">> = ["action", "analysis", "risk"];
    if (view === "summary") {
      for (const s of sections) kb.text(VIEW_LABEL[s], `tv:${s}:${outcomeId}`);
    } else {
      for (const s of sections.filter((s) => s !== view)) kb.text(VIEW_LABEL[s], `tv:${s}:${outcomeId}`);
      kb.row().text("⬅ Back", `tv:summary:${outcomeId}`);
    }
    return kb;
  }

  async send(signal: Signal, chartPng?: Buffer | null, opts?: SendOptions): Promise<SendResult> {
    const fullText = formatAlert(signal);
    const reply_markup = await this.followKeyboard(opts);

    if (chartPng) {
      try {
        // Photo captions cap at 1024 chars — split the management plan off into
        // a reply message rather than losing the chart to a caption error.
        const [caption, overflow] = splitCaption(fullText);
        // grammy's InputFile accepts a Buffer directly
        const { InputFile } = await import("grammy");
        const msg = await this.bot.api.sendPhoto(this.chatId, new InputFile(chartPng, "chart.png"), {
          caption,
          reply_markup,
        });
        if (overflow) {
          await this.bot.api
            .sendMessage(this.chatId, overflow, {
              reply_parameters: { message_id: msg.message_id },
            })
            .catch((err: Error) => logger.warn(`[notify] plan follow-up failed: ${err.message}`));
        }
        logger.info(`[notify] Sent ${signal.symbol} ${signal.direction} chart to Telegram`);
        return { messageId: msg.message_id, isPhoto: true };
      } catch (err) {
        logger.warn(`[notify] sendPhoto failed (${(err as Error).message}), falling back to text`);
      }
    }

    // Fallback: text-only message
    const msg = await this.bot.api.sendMessage(this.chatId, clampMessage(fullText, false), { reply_markup });
    logger.info(`[notify] Sent ${signal.symbol} ${signal.direction} to Telegram (text only)`);
    return { messageId: msg.message_id, isPhoto: false };
  }

  async sendOutcome(
    outcome: OutcomeRow,
    status: OutcomeStatus,
    hitPrice: number | null,
    closedAt: Date,
  ): Promise<void> {
    const text = formatOutcome(outcome, status, hitPrice, closedAt);
    await this.bot.api.sendMessage(this.chatId, text);
    logger.info(`[notify] Sent outcome ${status} for ${outcome.symbol} to Telegram`);
  }

  async sendSignalUpdate(update: SignalUpdate): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, formatSignalUpdate(update));
    logger.info(`[notify] Sent ${update.symbol} ${update.edgeState} update to Telegram`);
  }

  async sendManagement(text: string, opts?: { outcomeId?: number }): Promise<void> {
    let reply_markup;
    if (opts?.outcomeId != null) {
      const { InlineKeyboard } = await import("grammy");
      reply_markup = new InlineKeyboard().text("🔎 Details", `details:${opts.outcomeId}`);
    }
    await this.bot.api.sendMessage(this.chatId, clampMessage(text, false), { reply_markup });
    logger.info(`[notify] Sent trade-management alert to Telegram`);
  }

  async sendPositionTracked(position: BybitPosition, direction: Direction): Promise<SendResult> {
    const msg = await this.bot.api.sendMessage(this.chatId, formatPositionTracked(position, direction));
    logger.info(`[notify] Sent position-tracked ${position.symbol} ${direction} to Telegram`);
    return { messageId: msg.message_id, isPhoto: false };
  }

  async editMessage(messageId: number, isPhoto: boolean, text: string): Promise<void> {
    try {
      // The living trade report can outgrow a photo caption (1024) — clamp so
      // the in-place refresh never fails on length.
      const body = clampMessage(text, isPhoto);
      if (isPhoto) {
        await this.bot.api.editMessageCaption(this.chatId, messageId, { caption: body });
      } else {
        await this.bot.api.editMessageText(this.chatId, messageId, body);
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // An unchanged refresh ("message is not modified") is expected and harmless.
      if (msg.includes("message is not modified")) return;
      logger.warn(`[notify] editMessage #${messageId} failed: ${msg}`);
    }
  }

  async sendDigest(text: string): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, text);
    logger.info(`[notify] Sent analytics digest to Telegram`);
  }

  async sendOps(text: string): Promise<void> {
    // Best-effort: ops alerts must never throw into the caller (often a crash
    // handler that is already mid-shutdown).
    try {
      await this.bot.api.sendMessage(this.chatId, text);
    } catch (err) {
      logger.warn(`[ops] Telegram ops alert failed: ${(err as Error).message}`);
    }
  }

  private commandsStarted = false;

  startCommands(handlers: CommandHandlers): void {
    if (this.commandsStarted) return;
    const chatId = this.chatId;
    // Only respond in the configured chat — the bot is otherwise discoverable and
    // anyone could pull stats. Mismatched chats are silently ignored.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authorized = (ctx: any) => String(ctx.chat?.id) === chatId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.command("analytics", async (ctx: any) => {
      if (!authorized(ctx)) return;
      try {
        const n = Number.parseInt(String(ctx.match ?? "").trim(), 10);
        await ctx.reply(await handlers.analytics(Number.isFinite(n) ? n : undefined));
      } catch (err) {
        await ctx.reply(`⚠ analytics failed: ${(err as Error).message}`);
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.command("status", async (ctx: any) => {
      if (!authorized(ctx)) return;
      try {
        await ctx.reply(await handlers.status());
      } catch (err) {
        await ctx.reply(`⚠ status failed: ${(err as Error).message}`);
      }
    });

    // /running — interactive list of everything tracked, with per-trade Details buttons.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.command("running", async (ctx: any) => {
      if (!authorized(ctx)) return;
      try {
        const view = await handlers.running();
        await ctx.reply(view.text, { reply_markup: await this.detailsKeyboard(view.trades) });
      } catch (err) {
        await ctx.reply(`⚠ running failed: ${(err as Error).message}`);
      }
    });

    // /scan — no args (or "all") scans the whole watchlist; otherwise any coin
    // name works (handler normalizes "zec"/"BTC"/"wld" to the USDT perpetual).
    // When a candidate setup was found the briefing arrives as the chart's
    // caption (split into a reply if it outgrows the 1024-char caption limit);
    // with no setup there is no chart — text only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.command("scan", async (ctx: any) => {
      if (!authorized(ctx)) return;
      const arg = String(ctx.match ?? "").trim().toUpperCase();
      try {
        if (!arg || arg === "ALL") {
          await ctx.reply("⏳ Scanning all watchlist symbols…");
          await ctx.reply(clampMessage(await handlers.scanAll(), false));
          return;
        }
        await ctx.reply(`⏳ Scanning ${arg}…`);
        const reply = await handlers.scan(arg);
        if (reply.chart) {
          try {
            const [caption, overflow] = splitCaption(reply.text);
            const { InputFile } = await import("grammy");
            const msg = await ctx.replyWithPhoto(new InputFile(reply.chart, "chart.png"), { caption });
            if (overflow) {
              await ctx
                .reply(clampMessage(overflow, false), { reply_parameters: { message_id: msg.message_id } })
                .catch((err: Error) => logger.warn(`[notify] scan briefing overflow failed: ${err.message}`));
            }
            return;
          } catch (err) {
            logger.warn(`[notify] scan chart reply failed (${(err as Error).message}), falling back to text`);
          }
        }
        await ctx.reply(clampMessage(reply.text, false));
      } catch (err) {
        await ctx.reply(`⚠ scan failed: ${(err as Error).message}`);
      }
    });

    // /recent [n] — interactive evaluation card. The root scoreboard carries
    // [📋 View Trades] [📊 Performance]; every press edits the same message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.command("recent", async (ctx: any) => {
      if (!authorized(ctx)) return;
      try {
        const parsed = Number.parseInt(String(ctx.match ?? "").trim(), 10);
        const n = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 30)) : 10;
        const rows = await handlers.recentClosed(n);
        await ctx.reply(clampMessage(formatRecentRoot(rows), false), {
          parse_mode: "HTML",
          reply_markup: rows.length > 0 ? await this.recentKeyboard("root", n) : undefined,
        });
      } catch (err) {
        await ctx.reply(`⚠ recent failed: ${(err as Error).message}`);
      }
    });

    // Evaluation-card navigation. rc:<view>:<n> switches root/list/perf;
    // rc:trade:<id>:<n> opens one closed trade; rc:tanalysis:<id>:<n> shows its
    // persisted analysis (same renderer as the live trade card). All of them
    // EDIT the originating message in place — one card, no scroll.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^rc:(root|list|perf):(\d+)$/, async (ctx: any) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const view = ctx.match?.[1] as RecentView;
        const n = Number(ctx.match?.[2]);
        // Performance looks further back than the list so streaks/expectancy
        // stabilize; the other views honor the requested window.
        const rows = await handlers.recentClosed(view === "perf" ? Math.max(n, 90) : n);
        await ctx.answerCallbackQuery();
        const text =
          view === "list" ? formatRecentList(rows) :
          view === "perf" ? formatRecentPerformance(rows) :
          formatRecentRoot(rows);
        await ctx.editMessageText(clampMessage(text, false), {
          parse_mode: "HTML",
          reply_markup: await this.recentKeyboard(view, n, rows),
        });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("message is not modified")) {
          logger.warn(`[notify] recent view switch failed: ${msg}`);
        }
        await ctx.answerCallbackQuery().catch(() => {});
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^rc:(trade|tanalysis):(\d+):(\d+)$/, async (ctx: any) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const kind = ctx.match?.[1] as "trade" | "tanalysis";
        const id = Number(ctx.match?.[2]);
        const n = Number(ctx.match?.[3]);
        const row = await handlers.getOutcome(id);
        await ctx.answerCallbackQuery();
        if (!row) {
          await ctx.editMessageText("Trade not found.").catch(() => {});
          return;
        }
        const { InlineKeyboard } = await import("grammy");
        if (kind === "trade") {
          const kb = new InlineKeyboard()
            .text("\uD83E\uDDE0 Analysis", `rc:tanalysis:${id}:${n}`)
            .text("\u2B05 Back", `rc:list:${n}`);
          await ctx.editMessageText(clampMessage(formatRecentTrade(row), false), { parse_mode: "HTML", reply_markup: kb });
        } else {
          const kb = new InlineKeyboard().text("\u2B05 Back", `rc:trade:${id}:${n}`);
          await ctx.editMessageText(clampMessage(formatTradeView("analysis", row), false), { reply_markup: kb });
        }
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("message is not modified")) {
          logger.warn(`[notify] recent trade view failed: ${msg}`);
        }
        await ctx.answerCallbackQuery().catch(() => {});
      }
    });

    // Follow/Skip buttons on signal alerts. The callback data carries the signal id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAction = async (ctx: any, action: (id: number) => Promise<string>) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const id = Number(ctx.match?.[1]);
      try {
        const reply = await action(id);
        await ctx.answerCallbackQuery({ text: reply });
        // Clear the buttons so the decision can't be re-pressed.
        await ctx.editMessageReplyMarkup().catch(() => {});
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `error: ${(err as Error).message}` });
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^follow:(\d+)$/, (ctx: any) => handleAction(ctx, handlers.onFollow));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^skip:(\d+)$/, (ctx: any) => handleAction(ctx, handlers.onSkip));

    // Details button (/running list, management alerts) — opens the interactive
    // trade card: a 5-second summary with section buttons. Repeatable, so the
    // originating keyboard is left intact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^details:(\d+)$/, async (ctx: any) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const id = Number(ctx.match?.[1]);
        const row = await handlers.getOutcome(id);
        await ctx.answerCallbackQuery();
        if (!row) {
          await ctx.reply("Trade not found.");
          return;
        }
        await ctx.reply(clampMessage(formatTradeView("summary", row), false), {
          reply_markup: await this.tradeViewKeyboard(id, "summary"),
        });
      } catch (err) {
        await ctx.answerCallbackQuery({ text: `error: ${(err as Error).message}` }).catch(() => {});
      }
    });

    // Trade-card navigation — Action/Analysis/Risk/Back. Edits the card message
    // in place (one message, no scroll) and re-reads the row so every switch
    // shows the latest persisted state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.callbackQuery(/^tv:(summary|action|analysis|risk):(\d+)$/, async (ctx: any) => {
      if (!authorized(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const view = ctx.match?.[1] as TradeView;
        const id = Number(ctx.match?.[2]);
        const row = await handlers.getOutcome(id);
        await ctx.answerCallbackQuery();
        if (!row) {
          await ctx.editMessageText("Trade not found.").catch(() => {});
          return;
        }
        await ctx.editMessageText(clampMessage(formatTradeView(view, row), false), {
          reply_markup: await this.tradeViewKeyboard(id, view),
        });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // Re-pressing the current section is a harmless no-op edit.
        if (!msg.includes("message is not modified")) {
          logger.warn(`[notify] trade view switch failed: ${msg}`);
        }
        await ctx.answerCallbackQuery().catch(() => {});
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.catch((err: any) => logger.warn(`[notify] bot error: ${err?.message ?? err}`));

    // Advertise the commands in the Telegram UI (best-effort).
    this.bot.api
      .setMyCommands([
        { command: "scan", description: "scan a coin (/scan zec) or everything (/scan)" },
        { command: "running", description: "tracked trades with health & PnL" },
        { command: "recent", description: "evaluation card: streak, net R, per-trade results" },
        { command: "status", description: "current open signals" },
        { command: "analytics", description: "performance report (optional: days, e.g. /analytics 7)" },
      ])
      .catch(() => {});

    // Long-poll in the background. Resolves only on stop, so don't await it.
    void this.bot.start({
      onStart: () => logger.info("[notify] Telegram command listener started (/analytics, /status)"),
    });
    this.commandsStarted = true;
  }

  async stopCommands(): Promise<void> {
    if (!this.commandsStarted) return;
    try {
      await this.bot.stop();
    } catch (err) {
      logger.warn(`[notify] bot stop failed: ${(err as Error).message}`);
    }
  }
}

export async function createNotifier(env: Env): Promise<Notifier> {
  if (!env.telegramBotToken || !env.telegramChatId) {
    logger.info("[notify] No Telegram config — printing alerts to console");
    return new ConsoleNotifier();
  }
  try {
    const { Bot } = await import("grammy");
    const bot = new Bot(env.telegramBotToken);
    logger.info("[notify] Telegram notifier ready");
    return new TelegramNotifier(bot, env.telegramChatId);
  } catch (err) {
    logger.warn(`[notify] Telegram init failed (${(err as Error).message}) — using console`);
    return new ConsoleNotifier();
  }
}
