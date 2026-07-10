import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await readFile(resolve(here, "../dist/index.global.js"), "utf8");
const dom = new JSDOM("<!doctype html><main></main>", {
  runScripts: "outside-only",
  url: "https://example.test/",
});

dom.window.eval(bundle);

const api = dom.window.CaffeineJS;
const cache = api.caffeine({ maximumSize: 100 }).recordStats().build();
cache.set("a", 1);
cache.set("b", 2);
cache.get("a");

const result = {
  a: cache.get("a"),
  hasB: cache.has("b"),
  size: cache.size,
  hits: cache.stats().hitCount,
};

const ok = result.a === 1 && result.hasB && result.size === 2 && result.hits === 2;
if (!ok) {
  console.error("[smoke:browser] FAILED", result);
  process.exit(1);
}

console.log("[smoke:browser] OK", result);
