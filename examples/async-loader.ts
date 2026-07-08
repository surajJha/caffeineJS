/**
 * Async loading cache with request coalescing (stampede protection).
 * Run: `npx tsx examples/async-loader.ts`
 */
import { caffeine } from "../src/index.js";

let calls = 0;
async function fetchUser(id: string): Promise<{ id: string; name: string }> {
  calls++;
  await new Promise((r) => setTimeout(r, 50));
  return { id, name: `User-${id}` };
}

const loading = caffeine<string, { id: string; name: string }>({
  maximumSize: 10_000,
})
  .recordStats()
  .buildAsync((id) => fetchUser(id));

// 5 concurrent misses for the same key share ONE loader call.
const results = await Promise.all([
  loading.get("u1"),
  loading.get("u1"),
  loading.get("u1"),
  loading.get("u1"),
  loading.get("u1"),
]);

console.log("result =", results[0]);
console.log("loader calls =", calls); // 1, not 5
console.log("cached =", await loading.get("u1")); // no new call
console.log("stats =", loading.stats());
