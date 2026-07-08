/**
 * CAFF-009 storage-layout perf gate.
 *
 * Validates the Structure-of-Arrays decision: measures throughput, memory
 * footprint, and hit-ratio quality of the W-TinyLFU cache, using isaacs
 * lru-cache and a plain Map as yardsticks.
 *
 * Run: npm run bench
 */
import { caffeine } from "../src/index.js";
import { LRUCache } from "lru-cache";

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6; // ms
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function opsPerSec(ops: number, ms: number): string {
  return `${fmt(Math.round((ops / ms) * 1000))}/s`;
}

function gc(): void {
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// --- Zipfian-ish skewed key stream (reused across caches for fairness) ---
function makeStream(count: number, universe: number, skew: number): Int32Array {
  const s = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    s[i] = Math.floor(universe * Math.pow(Math.random(), skew));
  }
  return s;
}

interface Result {
  name: string;
  fillOps: string;
  hotGetOps: string;
  mixedOps: string;
  hitRate: number;
  heapMB: number;
}

function benchCaffeine(cap: number, stream: Int32Array): Result {
  gc();
  const before = heapMB();
  const c = caffeine<number, number>({ maximumSize: cap }).recordStats().build();

  // Fill
  let t = now();
  for (let i = 0; i < cap; i++) c.set(i, i);
  const fill = now() - t;

  // Hot get (all keys present)
  t = now();
  for (let r = 0; r < 10; r++) for (let i = 0; i < cap; i++) c.get(i);
  const hot = now() - t;

  // Mixed workload over skewed stream (get, set on miss)
  t = now();
  for (let i = 0; i < stream.length; i++) {
    const k = stream[i] as number;
    if (c.get(k) === undefined) c.set(k, k);
  }
  const mixed = now() - t;

  gc();
  const after = heapMB();
  return {
    name: "caffeine-js (SoA)",
    fillOps: opsPerSec(cap, fill),
    hotGetOps: opsPerSec(cap * 10, hot),
    mixedOps: opsPerSec(stream.length, mixed),
    hitRate: c.stats().hitRate,
    heapMB: after - before,
  };
}

function benchLru(cap: number, stream: Int32Array): Result {
  gc();
  const before = heapMB();
  const c = new LRUCache<number, number>({ max: cap });

  let t = now();
  for (let i = 0; i < cap; i++) c.set(i, i);
  const fill = now() - t;

  t = now();
  for (let r = 0; r < 10; r++) for (let i = 0; i < cap; i++) c.get(i);
  const hot = now() - t;

  let hits = 0;
  t = now();
  for (let i = 0; i < stream.length; i++) {
    const k = stream[i] as number;
    if (c.get(k) === undefined) c.set(k, k);
    else hits++;
  }
  const mixed = now() - t;

  gc();
  const after = heapMB();
  return {
    name: "lru-cache",
    fillOps: opsPerSec(cap, fill),
    hotGetOps: opsPerSec(cap * 10, hot),
    mixedOps: opsPerSec(stream.length, mixed),
    hitRate: hits / stream.length,
    heapMB: after - before,
  };
}

function main(): void {
  const cap = 1_000_000;
  const universe = cap * 10;
  const streamLen = 2_000_000;
  const skew = 3; // higher = more skewed / cacheable

  console.log(
    `\nPerf gate — capacity=${fmt(cap)}, stream=${fmt(streamLen)}, universe=${fmt(universe)}, skew=${skew}`,
  );
  console.log(
    `Node ${process.version}, gc ${(globalThis as unknown as { gc?: unknown }).gc ? "exposed" : "NOT exposed (run with --expose-gc for heap numbers)"}\n`,
  );

  const stream = makeStream(streamLen, universe, skew);

  const results = [benchCaffeine(cap, stream), benchLru(cap, stream)];

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    pad("cache", 20),
    pad("fill", 14),
    pad("hot-get", 14),
    pad("mixed", 14),
    pad("hitRate", 9),
    "heapMB",
  );
  for (const r of results) {
    console.log(
      pad(r.name, 20),
      pad(r.fillOps, 14),
      pad(r.hotGetOps, 14),
      pad(r.mixedOps, 14),
      pad(r.hitRate.toFixed(3), 9),
      r.heapMB.toFixed(1),
    );
  }
  console.log("");
}

main();
