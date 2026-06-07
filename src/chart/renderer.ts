// Chart renderer. Uses Puppeteer-core + system Chrome + Lightweight Charts to
// produce an 800×500 PNG buffer from a Signal + 15m candles.
//
// The HTML template is self-contained; data is injected via
// `page.evaluateOnNewDocument`. A shared browser instance is reused across
// renders, launched lazily on the first call.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import type { Signal, Candle } from "../types.js";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "template.html");

const CHART_WIDTH = 800;
const CHART_HEIGHT = 500;
const READY_TIMEOUT_MS = 8_000;
const LAUNCH_TIMEOUT_MS = 15_000;

// ── Chrome detection ────────────────────────────────────────────────────────

function findChrome(): string | undefined {
  // Env override
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const isWin = process.platform === "win32";

  if (isWin) {
    // Common Windows paths
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    // Registry lookup
    try {
      const reg = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve 2>nul',
        { encoding: "utf8" },
      );
      const match = reg.match(/REG_SZ\s+(.+)/);
      if (match?.[1] && existsSync(match[1].trim())) return match[1].trim();
    } catch { /* no registry entry */ }
  } else {
    // Linux / macOS
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ── Lazy browser singleton ──────────────────────────────────────────────────

type Browser = import("puppeteer-core").Browser;
let _browser: Browser | null = null;
let _launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error(
        "Chrome not found. Install Google Chrome or set CHROME_PATH env var.",
      );
    }

    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      timeout: LAUNCH_TIMEOUT_MS,
    });
    _browser = browser;
    _launching = null;
    logger.info(`[chart] Browser launched (${chromePath})`);
    return browser;
  })();
  return _launching;
}

/** Clean up the browser on process exit. */
function installShutdownHook(): void {
  const cleanup = () => {
    if (_browser) {
      _browser.close().catch(() => {});
      _browser = null;
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}
installShutdownHook();

// ── Chart data shape (passed to the HTML template) ──────────────────────────

interface ChartData {
  candles: Candle[];
  signal: {
    symbol: string;
    strategy: string;
    direction: string;
    confidence: number;
    setup_quality: number;
    rr: number;
    entry_low: number;
    entry_high: number;
    sl: number;
    tp: number;
    snapshot: Signal["snapshot"];
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a chart PNG for the given signal.
 *
 * @param signal  The approved signal to render.
 * @param candles 15m candles — the chart will display these.
 * @returns       PNG image buffer, or `null` if rendering fails.
 */
export async function renderChart(
  signal: Signal,
  candles: Candle[],
): Promise<Buffer | null> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: CHART_WIDTH, height: CHART_HEIGHT, deviceScaleFactor: 2 });

      // Inject chart data before the template JS runs.
      const chartData: ChartData = {
        candles: candles.slice(-80), // Last 80 candles — readable at 800px
        signal: {
          symbol: signal.symbol,
          strategy: signal.strategy,
          direction: signal.direction,
          confidence: signal.confidence,
          setup_quality: signal.setup_quality,
          rr: signal.rr,
          entry_low: signal.entry_low,
          entry_high: signal.entry_high,
          sl: signal.sl,
          tp: signal.tp,
          snapshot: signal.snapshot,
        },
      };

      await page.evaluateOnNewDocument((data: ChartData) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__CHART_DATA__ = data;
      }, chartData);

      // Navigate to the template file
      const templateUrl = `file://${TEMPLATE_PATH.replace(/\\/g, "/")}`;
      await page.goto(templateUrl, { waitUntil: "networkidle0", timeout: READY_TIMEOUT_MS });

      // Wait for the chart to signal readiness
      await page.waitForFunction("window.__CHART_READY__ === true", {
        timeout: READY_TIMEOUT_MS,
      });

      // Small delay for chart rendering to settle
      await new Promise((r) => setTimeout(r, 300));

      const screenshot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: CHART_WIDTH, height: CHART_HEIGHT },
      });

      logger.info(`[chart] Rendered ${signal.symbol} ${signal.strategy} (${screenshot.byteLength} bytes)`);
      return Buffer.from(screenshot);
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    logger.error(`[chart] Render failed for ${signal.symbol}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Force-close the shared browser instance. Useful for graceful shutdown.
 */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    logger.info("[chart] Browser closed");
  }
}
