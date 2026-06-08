// Install Chrome-for-Testing into the puppeteer cache so the chart renderer has
// a browser. puppeteer-core does NOT download one, so without this the bot falls
// back to text-only alerts (no chart image).
//
// Idempotent: skips a build that is already installed. Cross-platform: installs
// into PUPPETEER_CACHE_DIR or ~/.cache/puppeteer, exactly where the renderer
// (src/chart/renderer.ts) looks.
import {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  getInstalledBrowsers,
  Browser,
} from "@puppeteer/browsers";
import { homedir } from "node:os";
import { join } from "node:path";

const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(homedir(), ".cache", "puppeteer");

const platform = detectBrowserPlatform();
if (!platform) {
  console.error("Unsupported platform — cannot download Chrome. Install system Chrome and set CHROME_PATH.");
  process.exit(1);
}

try {
  const buildId = await resolveBuildId(Browser.CHROME, platform, "stable");

  const installed = await getInstalledBrowsers({ cacheDir });
  const already = installed.find((b) => b.browser === Browser.CHROME && b.buildId === buildId);
  if (already) {
    console.log(`Chrome ${buildId} already installed → ${already.executablePath}`);
    process.exit(0);
  }

  console.log(`Installing Chrome ${buildId} → ${cacheDir}`);
  const result = await install({ browser: Browser.CHROME, buildId, cacheDir });
  console.log(`Chrome installed → ${result.executablePath}`);
} catch (err) {
  console.error(`Chrome install failed: ${err?.message ?? err}`);
  console.error(
    "Charts will fall back to text-only alerts. On a bare Linux server you may also need\n" +
      "Chrome's shared libraries (Debian/Ubuntu: apt-get install -y libnss3 libatk-bridge2.0-0\n" +
      "libgtk-3-0 libasound2 libxshmfence1 fonts-liberation), or install system Chrome and set CHROME_PATH.",
  );
  process.exit(1);
}
