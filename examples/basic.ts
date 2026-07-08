/**
 * Basic bounded cache. Run: `npx tsx examples/basic.ts`
 */
import { caffeine } from "../src/index.js";

const cache = caffeine<string, number>({ maximumSize: 3 })
  .recordStats()
  .removalListener((k, _v, cause) => console.log(`evicted ${k} (${cause})`))
  .build();

cache.set("a", 1);
cache.set("b", 2);
cache.set("c", 3);
cache.get("a"); // touch "a" so it stays hot
cache.set("d", 4); // over capacity → a cold key is evicted

console.log("a =", cache.get("a"));
console.log("size =", cache.size);
console.log("stats =", cache.stats());
