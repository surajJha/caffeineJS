import { describe, it, expect } from "vitest";
import { caffeine } from "../src/index.js";
import type { RemovalCause } from "../src/index.js";

/** A controllable millisecond clock for deterministic TTL tests. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("TTL expiration (CAFF-020)", () => {
  it("expires entries after write", () => {
    const clk = fakeClock();
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(1000)
      .clock(clk.now)
      .build();
    c.set("a", 1);
    clk.advance(999);
    expect(c.get("a")).toBe(1);
    clk.advance(2);
    expect(c.get("a")).toBeUndefined();
    expect(c.has("a")).toBe(false);
    expect(c.size).toBe(0);
  });

  it("write TTL is not refreshed by reads", () => {
    const clk = fakeClock();
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(1000)
      .clock(clk.now)
      .build();
    c.set("a", 1);
    clk.advance(800);
    expect(c.get("a")).toBe(1); // read does not extend a write TTL
    clk.advance(300);
    expect(c.get("a")).toBeUndefined();
  });

  it("expireAfterAccess refreshes on read", () => {
    const clk = fakeClock();
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterAccess(1000)
      .clock(clk.now)
      .build();
    c.set("a", 1);
    clk.advance(800);
    expect(c.get("a")).toBe(1); // resets the access deadline
    clk.advance(800);
    expect(c.get("a")).toBe(1); // still alive because last access was recent
    clk.advance(1001);
    expect(c.get("a")).toBeUndefined();
  });

  it("uses the earliest of write and access deadlines when both set", () => {
    const clk = fakeClock();
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(1000)
      .expireAfterAccess(5000)
      .clock(clk.now)
      .build();
    c.set("a", 1);
    // Keep accessing; the write bound still caps total lifetime at 1000ms.
    clk.advance(600);
    expect(c.get("a")).toBe(1);
    clk.advance(600);
    expect(c.get("a")).toBeUndefined();
  });

  it("fires the removal listener with cause 'expired' on lazy access", () => {
    const clk = fakeClock();
    const seen: [string, number, RemovalCause][] = [];
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(1000)
      .clock(clk.now)
      .removalListener((k, v, cause) => seen.push([k, v, cause]))
      .build();
    c.set("a", 1);
    clk.advance(1500);
    c.get("a");
    expect(seen).toEqual([["a", 1, "expired"]]);
  });

  it("runMaintenance reclaims expired entries proactively via the timer wheel", () => {
    const clk = fakeClock();
    const seen: RemovalCause[] = [];
    const c = caffeine<string, number>({ maximumSize: 1000 })
      .expireAfterWrite(1000)
      .clock(clk.now)
      .removalListener((_k, _v, cause) => seen.push(cause))
      .build();
    for (let i = 0; i < 500; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(500);
    clk.advance(2000);
    c.runMaintenance();
    expect(c.size).toBe(0);
    expect(seen.length).toBe(500);
    expect(seen.every((cause) => cause === "expired")).toBe(true);
  });

  it("reclaims entries scheduled in coarser timer-wheel levels", () => {
    const clk = fakeClock(0);
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(200_000) // ~200s → lands in a higher wheel level
      .clock(clk.now)
      .build();
    c.set("a", 1);
    clk.advance(100_000);
    c.runMaintenance();
    expect(c.size).toBe(1); // not yet due
    clk.advance(150_000);
    c.runMaintenance();
    expect(c.size).toBe(0);
  });

  it("rejects non-positive TTLs", () => {
    expect(() =>
      caffeine<string, number>({ maximumSize: 10, expireAfterWrite: 0 }).build(),
    ).toThrow();
    expect(() =>
      caffeine<string, number>({ maximumSize: 10, expireAfterAccess: -5 }).build(),
    ).toThrow();
  });
});

describe("removal listener hardening (CAFF-024)", () => {
  it("delivers replaced then explicit causes", () => {
    const seen: [string, number, RemovalCause][] = [];
    const c = caffeine<string, number>({ maximumSize: 100 })
      .removalListener((k, v, cause) => seen.push([k, v, cause]))
      .build();
    c.set("a", 1);
    c.set("a", 2); // replaced -> old value 1
    c.delete("a"); // explicit -> value 2
    expect(seen).toEqual([
      ["a", 1, "replaced"],
      ["a", 2, "explicit"],
    ]);
  });

  it("is safe against a listener that re-enters the cache", () => {
    const c = caffeine<string, number>({ maximumSize: 100 })
      .removalListener((k) => {
        if (k === "a") c.set("b", 99); // re-entrant mutation during delivery
      })
      .build();
    c.set("a", 1);
    expect(() => c.delete("a")).not.toThrow();
    expect(c.get("b")).toBe(99);
  });

  it("isolates listener exceptions without corrupting state", () => {
    const c = caffeine<string, number>({ maximumSize: 100 })
      .removalListener(() => {
        throw new Error("boom");
      })
      .build();
    c.set("a", 1);
    expect(() => c.delete("a")).not.toThrow();
    expect(c.size).toBe(0);
    c.set("z", 2);
    expect(c.get("z")).toBe(2);
  });

  it("fires 'size' cause on capacity eviction", () => {
    const causes: RemovalCause[] = [];
    const c = caffeine<string, number>({ maximumSize: 3 })
      .removalListener((_k, _v, cause) => causes.push(cause))
      .build();
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(3);
    expect(causes.filter((x) => x === "size").length).toBe(7);
  });
});

describe("utility methods (CAFF-026)", () => {
  it("putAll, getIfPresent, invalidate, invalidateAll, asMap", () => {
    const c = caffeine<string, number>({ maximumSize: 100 }).build();
    c.putAll([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(c.getIfPresent("b")).toBe(2);
    c.invalidate("b");
    expect(c.getIfPresent("b")).toBeUndefined();
    const m = c.asMap();
    expect(m).toBeInstanceOf(Map);
    expect(m.get("a")).toBe(1);
    expect([...m.keys()].sort()).toEqual(["a", "c"]);
    c.invalidateAll(["a"]);
    expect(c.size).toBe(1);
    c.invalidateAll();
    expect(c.size).toBe(0);
  });

  it("iteration skips expired entries", () => {
    const clk = fakeClock();
    const c = caffeine<string, number>({ maximumSize: 100 })
      .expireAfterWrite(1000)
      .clock(clk.now)
      .build();
    c.set("a", 1);
    clk.advance(500);
    c.set("b", 2);
    clk.advance(600); // "a" now expired, "b" still alive
    expect([...c.keys()]).toEqual(["b"]);
    expect(c.asMap().has("a")).toBe(false);
  });
});
