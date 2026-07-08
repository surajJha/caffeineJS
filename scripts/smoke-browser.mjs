/**
 * Headless browser smoke. Loads the built ESM bundle into a Chromium page and
 * runs the shared assertions, proving the bundle works with no Node built-ins.
 *
 * `node scripts/smoke-browser.mjs` (requires `npx playwright install chromium`).
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../dist/index.mjs");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`[browser] ${m.text()}`));

  const result = await page.evaluate(async (url) => {
    const { caffeine } = await import(url);
    const cache = caffeine({ maximumSize: 100 }).recordStats().build();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    return {
      a: cache.get("a"),
      hasB: cache.has("b"),
      size: cache.size,
      hits: cache.stats().hitCount,
    };
  }, `file://${bundle}`);

  const ok =
    result.a === 1 && result.hasB && result.size === 2 && result.hits === 1;
  if (!ok) {
    console.error("[smoke:browser] FAILED", result);
    process.exit(1);
  }
  console.log("[smoke:browser] OK", result);
} finally {
  await browser.close();
}
