// Alert delivery. Sends to Telegram when configured, otherwise prints to console.
import type { Signal } from "./types.js";
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

export interface Notifier {
  send(signal: Signal): Promise<void>;
}

class ConsoleNotifier implements Notifier {
  async send(signal: Signal): Promise<void> {
    console.log("\n" + "─".repeat(48));
    console.log(formatAlert(signal));
    console.log("─".repeat(48) + "\n");
  }
}

class TelegramNotifier implements Notifier {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private bot: any, private chatId: string) {}
  async send(signal: Signal): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, formatAlert(signal));
    logger.info(`[notify] Sent ${signal.symbol} ${signal.direction} to Telegram`);
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
