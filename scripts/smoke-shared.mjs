/**
 * Shared smoke assertions used by every runtime smoke script.
 * Imports the built ESM bundle to verify it loads and works end-to-end.
 */
import { caffeine } from "../dist/index.mjs";

export function runSmoke(label) {
  const cache = caffeine({ maximumSize: 100 }).recordStats().build();
  cache.set("a", 1);
  cache.set("b", 2);

  assert(cache.get("a") === 1, "get a");
  assert(cache.has("b") === true, "has b");
  assert(cache.size === 2, "size");
  assert(cache.get("missing") === undefined, "miss");
  assert(cache.stats().hitCount === 1, "hitCount");

  cache.delete("a");
  assert(cache.get("a") === undefined, "deleted a");

  console.log(`[smoke:${label}] OK`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`[smoke] FAILED: ${msg}`);
    throw new Error(`smoke assertion failed: ${msg}`);
  }
}
