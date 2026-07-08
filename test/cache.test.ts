import { describe, it, expect } from "vitest";
import { caffeine } from "../src/index.js";

describe("cache core", () => {
  it("stores and retrieves values", () => {
    const c = caffeine<string, number>({ maximumSize: 100 }).build();
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.get("missing")).toBeUndefined();
    expect(c.size).toBe(2);
  });

  it("reports has/delete/clear", () => {
    const c = caffeine<string, number>({ maximumSize: 10 }).build();
    c.set("x", 1);
    expect(c.has("x")).toBe(true);
    expect(c.delete("x")).toBe(true);
    expect(c.delete("x")).toBe(false);
    expect(c.has("x")).toBe(false);
    c.set("y", 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("y")).toBeUndefined();
  });

  it("updates existing keys without growing size", () => {
    const c = caffeine<string, number>({ maximumSize: 10 }).build();
    c.set("k", 1);
    c.set("k", 2);
    expect(c.get("k")).toBe(2);
    expect(c.size).toBe(1);
  });

  it("peek does not affect stats or recency", () => {
    const c = caffeine<string, number>({ maximumSize: 10 })
      .recordStats()
      .build();
    c.set("k", 1);
    expect(c.peek("k")).toBe(1);
    expect(c.peek("nope")).toBeUndefined();
    const s = c.stats();
    expect(s.hitCount).toBe(0);
    expect(s.missCount).toBe(0);
  });

  it("never exceeds capacity", () => {
    const cap = 50;
    const c = caffeine<number, number>({ maximumSize: cap }).build();
    for (let i = 0; i < 10_000; i++) {
      c.set(i, i);
      expect(c.size).toBeLessThanOrEqual(cap);
    }
  });

  it("supports object keys by reference", () => {
    const c = caffeine<object, string>({ maximumSize: 10 }).build();
    const k1 = { id: 1 };
    const k2 = { id: 1 };
    c.set(k1, "a");
    expect(c.get(k1)).toBe("a");
    expect(c.get(k2)).toBeUndefined();
  });

  it("tracks hit/miss statistics when enabled", () => {
    const c = caffeine<string, number>({ maximumSize: 10 })
      .recordStats()
      .build();
    c.set("a", 1);
    c.get("a");
    c.get("a");
    c.get("b");
    const s = c.stats();
    expect(s.hitCount).toBe(2);
    expect(s.missCount).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it("fires removal listeners with correct causes", () => {
    const events: Array<[string, number, string]> = [];
    const c = caffeine<string, number>({ maximumSize: 10 })
      .removalListener((k, v, cause) => events.push([k, v, cause]))
      .build();
    c.set("a", 1);
    c.set("a", 2); // replaced
    c.delete("a"); // explicit
    expect(events).toContainEqual(["a", 1, "replaced"]);
    expect(events).toContainEqual(["a", 2, "explicit"]);
  });

  it("iterates keys, values, entries", () => {
    const c = caffeine<string, number>({ maximumSize: 10 }).build();
    c.set("a", 1);
    c.set("b", 2);
    expect(new Set(c.keys())).toEqual(new Set(["a", "b"]));
    expect(new Set(c.values())).toEqual(new Set([1, 2]));
    expect(new Set(c.entries())).toEqual(new Set([["a", 1], ["b", 2]] as [string, number][]));
  });

  it("protects frequently-read entries from eviction (batched reads)", () => {
    // With deferred read maintenance, buffered hits must still influence
    // admission: a hot key read many times should survive a flood of one-shot
    // insertions, whereas a never-read key must not.
    const cap = 100;
    const c = caffeine<number, number>({ maximumSize: cap }).build();
    c.set(-1, -1); // hot key
    c.set(-2, -2); // cold key (never read again)
    for (let round = 0; round < 1000; round++) {
      for (let r = 0; r < 20; r++) c.get(-1); // many reads → buffered
      c.set(1000 + round, round); // churn forces eviction + drains buffer
    }
    expect(c.get(-1)).toBe(-1); // hot survivor
    expect(c.get(-2)).toBeUndefined(); // cold evictee
  });

  it("stays consistent across interleaved reads, writes and deletes", () => {
    const cap = 32;
    const c = caffeine<number, number>({ maximumSize: cap }).build();
    const model = new Map<number, number>();
    for (let i = 0; i < 5000; i++) {
      const op = i % 3;
      const k = i % 40;
      if (op === 0) {
        c.set(k, i);
        model.set(k, i);
      } else if (op === 1) {
        c.get(k); // buffered read
      } else {
        c.delete(k);
        model.delete(k);
      }
      expect(c.size).toBeLessThanOrEqual(cap);
    }
    // Every key still resident must return the last value written for it.
    for (const [k, v] of model) {
      const got = c.get(k);
      if (got !== undefined) expect(got).toBe(v);
    }
  });
});
