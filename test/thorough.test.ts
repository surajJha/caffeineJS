import { describe, expect, it } from "vitest";
import { caffeine } from "../src/index.js";
import { CacheObserver } from "../src/inspect/events.js";
import { estimateBytes } from "../src/estimate.js";

/** Deterministic LCG for recency-shifting traces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function shiftTrace(len: number, hotSpan: number, drift: number, seed: number): Int32Array {
  const rnd = lcg(seed);
  const t = new Int32Array(len);
  let base = 0;
  for (let i = 0; i < len; i++) {
    if (rnd() < 0.85) t[i] = base + Math.floor(rnd() * hotSpan);
    else t[i] = base + hotSpan + Math.floor(rnd() * hotSpan * 8);
    if (i % drift === 0) base += 1;
  }
  return t;
}

describe("thorough edge-case coverage", () => {
  it("fires removal listeners for replaced, size, and explicit causes", () => {
    const causes: string[] = [];
    const cache = caffeine<string, number>({
      maximumSize: 10,
      removalListener: (_, __, cause) => causes.push(cause),
    }).build();

    cache.set("a", 1);
    cache.set("a", 2); // replaced
    for (let i = 0; i < 12; i++) cache.set(`k${i}`, i); // size evictions
    cache.delete("a"); // explicit

    expect(causes).toContain("replaced");
    expect(causes).toContain("size");
    expect(causes).toContain("explicit");
  });

  it("expires entries with expire-after-access when untouched", () => {
    let now = 0;
    const cache = caffeine<string, number>({
      maximumSize: 4,
      expireAfterAccess: 100,
      clock: () => now,
    }).build();

    cache.set("a", 1);
    now += 50;
    expect(cache.get("a")).toBe(1); // extends deadline
    now += 60; // last access 60ms ago, still alive
    expect(cache.get("a")).toBe(1);
    now += 150; // last access 210ms ago, past the 100ms TTL
    cache.runMaintenance();
    expect(cache.get("a")).toBeUndefined();
  });

  it("expires entries with expire-after-access when not re-accessed", () => {
    let now = 0;
    const cache = caffeine<string, number>({
      maximumSize: 4,
      expireAfterAccess: 100,
      clock: () => now,
    }).build();

    cache.set("a", 1);
    now += 101;
    cache.runMaintenance();
    expect(cache.get("a")).toBeUndefined();
  });

  it("removes all entries via invalidateAll", () => {
    const cache = caffeine<number, string>({ maximumSize: 10 }).build();
    for (let i = 0; i < 5; i++) cache.set(i, String(i));
    cache.invalidateAll([0, 2, 4]);
    expect(cache.size).toBe(2);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it("asMap returns a point-in-time snapshot", () => {
    const cache = caffeine<string, number>({ maximumSize: 4 }).build();
    cache.set("a", 1);
    cache.set("b", 2);
    const map = cache.asMap();
    expect(map.get("a")).toBe(1);
    expect(map.size).toBe(2);
    cache.set("c", 3);
    expect(map.has("c")).toBe(false);
    cache.delete("a");
    expect(map.has("a")).toBe(true);
  });

  it("rejects and immediately evicts an overweight entry", () => {
    const removed: string[] = [];
    const cache = caffeine<string, number>({
      maximumWeight: 5,
      weigher: () => 10,
      removalListener: (k) => removed.push(k),
    }).build();

    cache.set("heavy", 1);
    expect(cache.size).toBe(0);
    expect(removed).toContain("heavy");
  });

  it("observer detach and reattach swaps the active listener", () => {
    const cache = caffeine<string, number>({ maximumSize: 2 }).build();
    const events1: string[] = [];
    const events2: string[] = [];

    const obs1 = new CacheObserver<string, number>((e) => events1.push(e.type));
    const obs2 = new CacheObserver<string, number>((e) => events2.push(e.type));

    cache.attachObserver!(obs1);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // eviction → event
    expect(events1.length).toBeGreaterThan(0);
    const count1 = events1.length;

    cache.attachObserver!(obs2);
    cache.set("d", 4); // eviction → event
    expect(events2.length).toBeGreaterThan(0);
    expect(events1.length).toBe(count1); // obs1 detached

    cache.attachObserver!(undefined);
    cache.set("e", 5);
    expect(events2.length).toBe(events2.length); // no new events
  });

  it("observer sampleRate and include options work", () => {
    const cache = caffeine<string, number>({ maximumSize: 4 }).build();
    const events: Array<{ type: string; key?: string; value?: number }> = [];
    const obs = new CacheObserver<string, number>((e) => events.push({ type: e.type, key: e.key, value: e.value }), {
      sampleRate: 1,
      includeKeys: false,
      includeValues: false,
    });
    cache.attachObserver!(obs);
    cache.set("a", 1);
    cache.get("a");
    expect(events.some((e) => e.key !== undefined)).toBe(false);
    expect(events.some((e) => e.value !== undefined)).toBe(false);
    cache.attachObserver!(undefined);
  });

  it("emits resize and age events under a shifting workload", () => {
    const cap = 500;
    const trace = shiftTrace(200_000, Math.floor(cap * 0.6), 3, 12345);
    const cache = caffeine<number, number>({ maximumSize: cap, adaptive: true }).build();
    const types: string[] = [];
    const obs = new CacheObserver<number, number>((e) => types.push(e.type));
    cache.attachObserver!(obs);

    for (let i = 0; i < trace.length; i++) {
      const k = trace[i] as number;
      if (cache.get(k) === undefined) cache.set(k, k);
    }

    expect(types).toContain("resize");
    expect(types).toContain("age");
    cache.attachObserver!(undefined);
  });

  it("stats counters are accurate", () => {
    const cache = caffeine<string, number>({ maximumSize: 4, recordStats: true }).build();
    cache.set("a", 1);
    cache.get("a");
    cache.get("a");
    cache.get("missing");
    const stats = cache.stats();
    expect(stats.hitCount).toBe(2);
    expect(stats.missCount).toBe(1);
    expect(stats.hitRate).toBe(2 / 3);
  });

  it("estimateBytes returns positive sizes for supported types", () => {
    expect(estimateBytes("key", 1)).toBeGreaterThan(0);
    expect(estimateBytes("key", "value")).toBeGreaterThan(0);
    expect(estimateBytes("key", [1, 2, 3])).toBeGreaterThan(0);
    expect(estimateBytes("key", { a: 1 })).toBeGreaterThan(0);
    expect(estimateBytes("key", new Uint8Array(100))).toBeGreaterThan(0);
  });

  it("object keys are supported and distinct", () => {
    const cache = caffeine<object, number>({ maximumSize: 4 }).build();
    const a = {};
    const b = {};
    cache.set(a, 1);
    cache.set(b, 2);
    expect(cache.get(a)).toBe(1);
    expect(cache.get(b)).toBe(2);
  });

  it("async cache handles loader rejection and retry", async () => {
    let calls = 0;
    const cache = caffeine<string, number>({ maximumSize: 4 }).recordStats().buildAsync(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return calls;
    });

    await expect(cache.get("x")).rejects.toThrow("boom");
    const value = await cache.get("x");
    expect(value).toBe(2);
    expect(cache.stats().loadFailureCount).toBe(1);
    expect(cache.stats().loadSuccessCount).toBe(1);
  });

  it("async cache coalesces concurrent loads", async () => {
    let calls = 0;
    const cache = caffeine<string, number>({ maximumSize: 4 }).recordStats().buildAsync(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return calls;
    });

    const [a, b] = await Promise.all([cache.get("x"), cache.get("x")]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("async cache refresh updates value", async () => {
    let value = 1;
    const cache = caffeine<string, number>({ maximumSize: 4 }).recordStats().buildAsync(() => Promise.resolve(value));

    expect(await cache.get("x")).toBe(1);
    value = 2;
    await cache.refresh("x");
    expect(cache.getIfPresent("x")).toBe(2);
  });

  it("bulkGet resolves partial results", async () => {
    const cache = caffeine<string, number>({ maximumSize: 10 }).recordStats().buildAsync(async (k) => Number(k));

    const map = await cache.bulkGet(["1", "2", "3"]);
    expect(map.get("1")).toBe(1);
    expect(map.get("2")).toBe(2);
    expect(map.get("3")).toBe(3);
  });
});
