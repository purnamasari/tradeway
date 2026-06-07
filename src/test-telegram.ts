// Quick Telegram connectivity test — run via: pnpm test:telegram
import { loadEnv } from "./config.js";
import { logger } from "./logger.js";

// Load .env if present (Node 22 builtin; no dependency).
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env file — fine
}

async function main() {
  const env = loadEnv();

  if (!env.telegramBotToken || !env.telegramChatId) {
    logger.error("[test:telegram] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env");
    process.exit(1);
  }

  try {
    const { Bot } = await import("grammy");
    const bot = new Bot(env.telegramBotToken);

    const me = await bot.api.getMe();
    logger.info(`[test:telegram] Bot connected: @${me.username} (${me.first_name})`);

    const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" });
    const msg = [
      `✅ TradeAway Bot Test`,
      ``,
      `Bot:  @${me.username}`,
      `Chat: ${env.telegramChatId}`,
      `Time: ${now}`,
      ``,
      `Telegram integration is working correctly.`,
    ].join("\n");

    await bot.api.sendMessage(env.telegramChatId, msg);
    logger.info(`[test:telegram] Test message sent successfully to chat ${env.telegramChatId}`);
  } catch (err) {
    logger.error(`[test:telegram] Failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
