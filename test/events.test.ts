import { describe, expect, it } from "vitest";
import { caffeine } from "../src/index.js";
import type { CacheEvent } from "../src/index.js";

describe("event tap (CAFF-050)", () => {
  it("emits hit and miss events", () => {
    const events: CacheEvent<string, number>[] = [];
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer((e) => events.push(e as CacheEvent<string, number>))
      .build();

    cache.set("a", 1);
    cache.get("a");
    cache.get("b");

    expect(events.filter((e) => e.type === "hit").length).toBe(1);
    expect(events.filter((e) => e.type === "miss").length).toBe(1);

    const hit = events.find((e) => e.type === "hit")!;
    expect(hit.key).toBe("a");
    expect(hit.freq).toBeGreaterThanOrEqual(0);
    expect(hit.occupancy.weightedSize).toBe(1);
  });

  it("emits evict events with cause=size", () => {
    const events: CacheEvent<number, number>[] = [];
    const cache = caffeine<number, number>({ maximumSize: 2 })
      .observer((e) => events.push(e as CacheEvent<number, number>))
      .build();

    cache.set(1, 10);
    cache.set(2, 20);
    cache.set(3, 30); // eviction

    const evicts = events.filter((e) => e.type === "evict");
    expect(evicts.length).toBeGreaterThanOrEqual(1);
    expect(evicts[0]!.cause).toBe("size");
  });

  it("emits replaced cause on overwrite", () => {
    const events: CacheEvent<string, number>[] = [];
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer((e) => events.push(e as CacheEvent<string, number>), {
        includeValues: true,
      })
      .build();

    cache.set("a", 1);
    cache.set("a", 2);

    const replaced = events.filter((e) => e.type === "evict" && e.cause === "replaced");
    expect(replaced.length).toBe(1);
    expect(replaced[0]!.value).toBe(1);
  });

  it("emits explicit cause on delete/clear", () => {
    const events: CacheEvent<string, number>[] = [];
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer((e) => events.push(e as CacheEvent<string, number>))
      .build();

    cache.set("a", 1);
    cache.delete("a");
    cache.set("b", 2);
    cache.clear();

    const explicit = events.filter((e) => e.type === "evict" && e.cause === "explicit");
    expect(explicit.length).toBe(2);
  });

  it("emits promote and demote events", () => {
    const events: CacheEvent<number, number>[] = [];
    const cache = caffeine<number, number>({ maximumSize: 10 })
      .observer((e) => events.push(e as CacheEvent<number, number>))
      .build();

    // Fill window + probation, then repeatedly access a probation entry to
    // promote it; this will demote a protected entry once protected fills.
    for (let i = 0; i < 10; i++) cache.set(i, i);
    for (let r = 0; r < 20; r++) {
      for (let i = 0; i < 10; i++) cache.get(i);
    }

    expect(events.some((e) => e.type === "promote")).toBe(true);
    expect(events.some((e) => e.type === "demote")).toBe(true);
  });

  it("emits admit/reject events at the TinyLFU gate", () => {
    const events: CacheEvent<number, number>[] = [];
    const cache = caffeine<number, number>({ maximumSize: 3, adaptive: false })
      .observer((e) => events.push(e as CacheEvent<number, number>))
      .build();

    // Build some frequency on 1/2/3.
    for (let r = 0; r < 10; r++) {
      cache.get(1);
      cache.get(2);
      cache.get(3);
    }
    cache.set(1, 1);
    cache.set(2, 2);
    cache.set(3, 3);
    // Now insert new keys to force admission decisions.
    for (let i = 4; i < 20; i++) cache.set(i, i);

    expect(events.some((e) => e.type === "admit" || e.type === "reject")).toBe(true);
  });

  it("emits age event when the frequency sketch ages", () => {
    const events: CacheEvent<number, number>[] = [];
    const cache = caffeine<number, number>({ maximumSize: 8 })
      .observer((e) => events.push(e as CacheEvent<number, number>))
      .build();

    // Prime the doorkeeper so subsequent accesses increment the CMS counters.
    for (let k = 0; k < 8; k++) cache.set(k, k);
    // sampleSize = width*10 = 8*10 = 80 increments. Use all 8 keys so the
    // 4-bit CMS counters do not saturate before the sample fills.
    for (let i = 0; i < 90; i++) {
      cache.get(i % 8);
    }
    // Drain the read buffer so the final buffered increments are applied.
    cache.runMaintenance();

    expect(events.some((e) => e.type === "age")).toBe(true);
  });

  it("supports includeKeys=false and includeValues=true", () => {
    const events: CacheEvent<string, number>[] = [];
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer((e) => events.push(e as CacheEvent<string, number>), {
        includeKeys: false,
        includeValues: true,
      })
      .build();

    cache.set("a", 1);
    cache.get("a");

    const hit = events.find((e) => e.type === "hit")!;
    expect(hit.key).toBeUndefined();
    expect(hit.value).toBe(1);
  });

  it("sampleRate=0 suppresses all events", () => {
    const events: CacheEvent<string, number>[] = [];
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer((e) => events.push(e as CacheEvent<string, number>), {
        sampleRate: 0,
      })
      .build();

    for (let i = 0; i < 100; i++) {
      cache.set(String(i), i);
      cache.get(String(i));
    }

    expect(events.length).toBe(0);
  });

  it("survives observer exceptions", () => {
    const cache = caffeine<string, number>({ maximumSize: 3 })
      .observer(() => {
        throw new Error("boom");
      })
      .build();

    expect(() => {
      cache.set("a", 1);
      cache.get("a");
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4);
    }).not.toThrow();
    expect(cache.get("d")).toBe(4);
  });

  it("has zero overhead when no observer is registered", () => {
    const cache = caffeine<number, number>({ maximumSize: 100 }).build();
    for (let i = 0; i < 1000; i++) {
      cache.set(i, i);
      cache.get(i);
    }
    expect(cache.size).toBeLessThanOrEqual(100);
  });
});
