/**
 * TTL expiry with an injectable clock (deterministic, no real timers).
 * Run: `npx tsx examples/ttl.ts`
 */
import { caffeine } from "../src/index.js";

let clock = 0;

const cache = caffeine<string, string>({ maximumSize: 100 })
  .expireAfterWrite(1_000) // entries expire 1s after write
  .clock(() => clock)
  .removalListener((k, _v, cause) => console.log(`removed ${k} (${cause})`))
  .build();

cache.set("session", "abc");
console.log("t=0   session =", cache.get("session")); // abc

clock = 500;
console.log("t=500 session =", cache.get("session")); // abc

clock = 1_500;
cache.runMaintenance(); // reclaim expired entries (edge-runtime safe)
console.log("t=1500 session =", cache.get("session")); // undefined
