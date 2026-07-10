import { describe, it, expect } from "vitest";
import { caffeine } from "../src/index.js";
import { estimateBytes, sizeOfValue } from "../src/estimate.js";

describe("weighted entries", () => {
  it("bounds total weight, not count", () => {
    const c = caffeine<string, string>({})
      .maximumWeight(100, (_k, v) => v.length)
      .build();
    for (let i = 0; i < 50; i++) c.set(`k${i}`, "x".repeat(10));
    let total = 0;
    for (const v of c.values()) total += v.length;
    expect(total).toBeLessThanOrEqual(100);
    expect(c.size).toBeLessThanOrEqual(10);
  });

  it("recomputes weight on value update so freed weight admits more", () => {
    const c = caffeine<string, string>({})
      .maximumWeight(100, (_k, v) => v.length)
      .adaptive(false)
      .build();
    c.set("a", "x".repeat(90));
    expect(c.get("a")).toBeDefined();
    c.set("a", "y".repeat(10));
    c.set("b", "z".repeat(80));
    expect(c.get("a")).toBe("y".repeat(10));
    expect(c.get("b")).toBe("z".repeat(80));
  });

  it("does not retain an entry heavier than the whole bound", () => {
    const c = caffeine<string, string>({})
      .maximumWeight(50, (_k, v) => v.length)
      .build();
    c.set("small", "abc");
    c.set("huge", "x".repeat(100));
    let total = 0;
    for (const v of c.values()) total += v.length;
    expect(total).toBeLessThanOrEqual(50);
  });

  it("grows the store past its initial capacity", () => {
    const c = caffeine<number, number>({})
      .maximumWeight(1_000_000, () => 1)
      .expectedEntries(16)
      .build();
    for (let i = 0; i < 5000; i++) c.set(i, i * 2);
    expect(c.size).toBe(5000);
    expect(c.get(0)).toBe(0);
    expect(c.get(4999)).toBe(9998);
  });

  it("validates configuration", () => {
    expect(() => caffeine<string, number>({}).build()).toThrow();
    expect(() =>
      caffeine<string, number>({ maximumSize: 10, maximumWeight: 10 }).build(),
    ).toThrow();
    expect(() => caffeine<string, number>({ maximumWeight: 10 }).build()).toThrow();
    for (const maximumWeight of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => caffeine<string, number>({ maximumWeight, weigher: () => 1 }).build()).toThrow(
        /maximumWeight/,
      );
    }
    for (const expectedEntries of [0, -1, 1.2, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        caffeine<string, number>({ maximumWeight: 10, weigher: () => 1, expectedEntries }).build(),
      ).toThrow(/expectedEntries/);
    }
  });

  it("rejects invalid weight results", () => {
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const c = caffeine<string, string>({})
        .maximumWeight(10, () => bad)
        .build();
      expect(() => c.set("bad", "value")).toThrow(/weigher/);
    }
  });

  it("rejects TTL combined with weight bounding in v1", () => {
    expect(() =>
      caffeine<string, string>({ expireAfterWrite: 1000 })
        .maximumWeight(100, (_k, v) => v.length)
        .build(),
    ).toThrow();
  });
});

describe("byte estimator", () => {
  it("estimates strings, numbers, and typed arrays", () => {
    expect(sizeOfValue("abcd")).toBe(4 * 2 + 16);
    expect(sizeOfValue(42)).toBe(8);
    expect(sizeOfValue(true)).toBe(4);
    expect(sizeOfValue(new Uint8Array(100))).toBe(100 + 32);
  });

  it("walks nested objects and arrays", () => {
    const v = { a: 1, b: [1, 2, 3], c: { d: "hi" } };
    expect(sizeOfValue(v)).toBeGreaterThan(40);
  });

  it("includes fixed per-entry overhead and both key+value", () => {
    const total = estimateBytes("k", "value");
    expect(total).toBeGreaterThan(220);
  });

  it("drives an approximate byte-bounded cache", () => {
    const c = caffeine<string, string>({}).maximumWeight(2000, estimateBytes).build();
    for (let i = 0; i < 100; i++) c.set(`k${i}`, "x".repeat(50));
    let total = 0;
    for (const [k, v] of c.entries()) total += estimateBytes(k, v);
    expect(total).toBeLessThanOrEqual(2000);
    expect(c.size).toBeGreaterThan(0);
  });

  it("handles cycles without infinite recursion", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => sizeOfValue(a)).not.toThrow();
  });
});
