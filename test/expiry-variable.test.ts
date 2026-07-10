import { describe, it, expect, vi } from "vitest";
import { caffeine } from "../src/index.js";
import type { Expiry } from "../src/types.js";

describe("variable expiry (expireAfter)", () => {
  it("uses create hook to set per-entry TTL", () => {
    let now = 0;
    const clock = () => now;
    const expiry: Expiry<string, number> = {
      expireAfterCreate: () => 100,
      expireAfterUpdate: () => 100,
      expireAfterRead: (_k, _v, _now, remaining) => remaining,
    };

    const cache = caffeine<string, number>({ maximumSize: 10, expireAfter: expiry, clock }).build();
    cache.set("a", 1);
    now = 50;
    expect(cache.get("a")).toBe(1);
    now = 101;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("calls update hook on overwrite", () => {
    let now = 0;
    const clock = () => now;
    const create = vi.fn(() => 50);
    const update = vi.fn((_k, _v, _now, remaining) => remaining / 2);
    const read = vi.fn((_k, _v, _now, remaining) => remaining);

    const cache = caffeine<string, number>({
      maximumSize: 10,
      expireAfter: { expireAfterCreate: create, expireAfterUpdate: update, expireAfterRead: read },
      clock,
    }).build();

    cache.set("a", 1);
    expect(create).toHaveBeenCalledTimes(1);

    now = 40; // 10 ms remaining before update
    cache.set("a", 2);
    expect(update).toHaveBeenCalledWith("a", 2, 40, 10);
    now = 44; // updated to 5 ms, expired at 45
    expect(cache.get("a")).toBe(2);
    now = 46;
    expect(cache.get("a")).toBeUndefined();
  });

  it("calls read hook to extend/shorten TTL", () => {
    let now = 0;
    const clock = () => now;
    const read = vi.fn((_k, _v, _now, remaining) => remaining + 10);

    const cache = caffeine<string, number>({
      maximumSize: 10,
      expireAfter: {
        expireAfterCreate: () => 20,
        expireAfterUpdate: () => 20,
        expireAfterRead: read,
      },
      clock,
    }).build();

    cache.set("a", 1);
    now = 15;
    expect(cache.get("a")).toBe(1); // read extends by 10 from 5 remaining -> 15
    expect(read).toHaveBeenCalledWith("a", 1, 15, 5);
    now = 25; // would have expired under original TTL of 20; still alive
    cache.runMaintenance();
    expect(cache.peek("a")).toBe(1);
    now = 31; // beyond extended deadline of 30
    cache.runMaintenance();
    expect(cache.peek("a")).toBeUndefined();
  });

  it("expires different keys at different times", () => {
    let now = 0;
    const clock = () => now;
    const expiry: Expiry<string, number> = {
      expireAfterCreate: (key) => (key === "short" ? 10 : 1000),
      expireAfterUpdate: () => 1000,
      expireAfterRead: () => 1000,
    };

    const cache = caffeine<string, number>({ maximumSize: 10, expireAfter: expiry, clock }).build();
    cache.set("short", 1);
    cache.set("long", 2);
    now = 50;
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe(2);
  });

  it("rejects expireAfter combined with global TTL", () => {
    expect(() =>
      caffeine({
        maximumSize: 10,
        expireAfterWrite: 100,
        expireAfter: {
          expireAfterCreate: () => 100,
          expireAfterUpdate: () => 100,
          expireAfterRead: () => 100,
        },
      } as any).build(),
    ).toThrow(/mutually exclusive/);
  });

  it("fires removal listener with expired cause", () => {
    let now = 0;
    const clock = () => now;
    const removed: Array<[string, number, string]> = [];
    const cache = caffeine<string, number>({
      maximumSize: 10,
      expireAfter: {
        expireAfterCreate: () => 10,
        expireAfterUpdate: () => 10,
        expireAfterRead: () => 10,
      },
      clock,
      removalListener: (k, v, cause) => removed.push([String(k), v, cause]),
    }).build();

    cache.set("a", 1);
    now = 20;
    cache.runMaintenance();
    expect(removed).toEqual([["a", 1, "expired"]]);
  });

  it("returns Infinity duration as non-expiring", () => {
    let now = 0;
    const clock = () => now;
    const cache = caffeine<string, number>({
      maximumSize: 10,
      expireAfter: {
        expireAfterCreate: () => Infinity,
        expireAfterUpdate: () => Infinity,
        expireAfterRead: () => Infinity,
      },
      clock,
    }).build();

    cache.set("a", 1);
    now = 86_400_000; // 1 day later
    expect(cache.get("a")).toBe(1);
  });

  it("zero/negative durations expire immediately on next access", () => {
    let now = 0;
    const clock = () => now;
    const cache = caffeine<string, number>({
      maximumSize: 10,
      expireAfter: {
        expireAfterCreate: () => 0,
        expireAfterUpdate: () => 0,
        expireAfterRead: () => 0,
      },
      clock,
    }).build();

    cache.set("a", 1);
    now = 0;
    expect(cache.get("a")).toBeUndefined();
  });
});
