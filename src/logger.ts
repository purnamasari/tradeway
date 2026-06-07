// Minimal leveled logger. Timestamped, no deps.
type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

const SHOW_DEBUG = process.env.LOG_LEVEL === "debug";

function emit(level: Level, msg: string) {
  if (level === "debug" && !SHOW_DEBUG) return;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}`);
}

export const logger = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
