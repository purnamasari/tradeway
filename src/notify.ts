// Alert delivery. Sends to Telegram when configured, otherwise prints to console.
// Supports optional chart image attachment (PNG buffer) and outcome notifications.
import type { Signal, OutcomeStatus, SignalUpdate } from "./types.js";
import type { OutcomeRow } from "./db/accumulate.js";
import type { Env } from "./config.js";
import { logger } from "./logger.js";

export function formatExplainability(signal: Signal): string {
  const b = signal.score_breakdown;
  const lines: string[] = [];

  if (b.funding_percentile <= 10) lines.push(`✓ Funding bottom ${b.funding_percentile}% of 90d`);
  else if (b.funding_percentile >= 90) lines.push(`✓ Funding top ${(100 - b.funding_percentile)}% of 90d`);
  if (Math.abs(b.oi_zscore) >= 2.0) lines.push(`✓ OI z-score ${b.oi_zscore > 0 ? "+" : ""}${b.oi_zscore.toFixed(1)}`);
  if (b.volume_percentile >= 80) lines.push(`✓ Volume top ${Math.round(100 - b.volume_percentile)}% of recent`);

  lines.push(`✓ S/R strength ${b.sr_level_strength}`);
  if (b.engulf_body_ratio >= 1.0) lines.push(`✓ Engulf ratio ${b.engulf_body_ratio.toFixed(2)}×`);
  if (b.htf_aligned) lines.push(`✓ HTF 4H aligned`);
  if (b.sweep_wick_ratio) lines.push(`✓ Sweep wick ${b.sweep_wick_ratio.toFixed(2)}× body`);
  if (b.structure_intact) lines.push(`✓ Structure intact`);

  return lines.join("\n");
}

export function formatAlert(signal: Signal): string {
  const dir = signal.direction.toUpperCase();
  const emoji = signal.direction === "long" ? "🟢" : "🔴";
  return [
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
  ].join("\n");
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

// ── Outcome formatting ──────────────────────────────────────────────────────

const OUTCOME_EMOJI: Record<string, string> = {
  TP_HIT: "✅",
  SL_HIT: "❌",
  EXPIRED: "⏰",
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
    ? ` · ${formatPricePct(outcome.entry_price, hitPrice, outcome.direction)}`
    : "";

  return [
    `${emoji} ${outcome.symbol} ${dir} · ${status.replace("_", " ")}${pctStr}`,
    `Strategy: ${outcome.strategy} · Duration: ${duration}`,
    `Entry: ${outcome.entry_price}`,
    hitPrice !== null ? `Exit: ${hitPrice}` : null,
    `SL: ${outcome.sl}   TP: ${outcome.tp}`,
  ].filter(Boolean).join("\n");
}

// ── Notifier interface ──────────────────────────────────────────────────────

export interface Notifier {
  send(signal: Signal, chartPng?: Buffer | null): Promise<void>;
  sendOutcome(
    outcome: OutcomeRow,
    status: OutcomeStatus,
    hitPrice: number | null,
    closedAt: Date,
  ): Promise<void>;
  /** Edge-lifecycle update for an already-active signal (not a new signal). */
  sendSignalUpdate(update: SignalUpdate): Promise<void>;
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
}

// ── Open-signals status formatting (for /status) ────────────────────────────

export function formatStatus(rows: OutcomeRow[]): string {
  if (rows.length === 0) return "📡 No open signals.";
  const lines = [`📡 Open signals (${rows.length}):`, ""];
  for (const o of rows) {
    const conf =
      o.live_confidence != null
        ? `${o.original_confidence ?? "?"}→${o.live_confidence}`
        : `${o.original_confidence ?? "?"}`;
    lines.push(`${o.symbol} ${o.direction.toUpperCase()} · ${o.strategy}`);
    lines.push(`  ${o.status} · edge ${o.edge_state} · conf ${conf}`);
  }
  return lines.join("\n");
}

class ConsoleNotifier implements Notifier {
  async send(signal: Signal, chartPng?: Buffer | null): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(formatAlert(signal));
    if (chartPng) {
      console.log(`[chart: ${chartPng.byteLength} bytes PNG attached]`);
    }
    console.log("─".repeat(48) + "\n");
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private bot: any, private chatId: string) {}

  async send(signal: Signal, chartPng?: Buffer | null): Promise<void> {
    const caption = formatAlert(signal);

    if (chartPng) {
      try {
        // grammy's InputFile accepts a Buffer directly
        const { InputFile } = await import("grammy");
        await this.bot.api.sendPhoto(this.chatId, new InputFile(chartPng, "chart.png"), {
          caption,
        });
        logger.info(`[notify] Sent ${signal.symbol} ${signal.direction} chart to Telegram`);
        return;
      } catch (err) {
        logger.warn(`[notify] sendPhoto failed (${(err as Error).message}), falling back to text`);
      }
    }

    // Fallback: text-only message
    await this.bot.api.sendMessage(this.chatId, caption);
    logger.info(`[notify] Sent ${signal.symbol} ${signal.direction} to Telegram (text only)`);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bot.catch((err: any) => logger.warn(`[notify] bot error: ${err?.message ?? err}`));

    // Advertise the commands in the Telegram UI (best-effort).
    this.bot.api
      .setMyCommands([
        { command: "analytics", description: "performance report (optional: days, e.g. /analytics 7)" },
        { command: "status", description: "current open signals" },
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
