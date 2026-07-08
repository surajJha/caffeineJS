/**
 * Byte-bounded cache (~approximate 1 MB) using the built-in estimator.
 * Run: `npx tsx examples/byte-bounded.ts`
 *
 * NB: JS cannot measure exact object size — this is a documented approximation.
 */
import { caffeine } from "../src/index.js";
import { estimateBytes } from "../src/estimate.js";

const ONE_MB = 1024 * 1024;

const cache = caffeine<string, string>({})
  .maximumWeight(ONE_MB, (k, v) => estimateBytes(k, v))
  .recordStats()
  .build();

// Fill with ~10 KB strings; the cache evicts to stay under ~1 MB of weight.
for (let i = 0; i < 500; i++) {
  cache.set(`key-${i}`, "x".repeat(10_000));
}

console.log("entries kept =", cache.size); // ~100 (1 MB / ~10 KB)
console.log("stats =", cache.stats());
