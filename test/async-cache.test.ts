import { describe, it, expect, vi } from "vitest";
import { caffeine } from "../src/index.js";

describe("async loading cache", () => {
  it("loads on miss and serves from cache on hit", async () => {
    const loader = vi.fn(async (k: string) => `v:${k}`);
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);
    expect(await c.get("a")).toBe("v:a");
    expect(await c.get("a")).toBe("v:a");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(c.getIfPresent("a")).toBe("v:a");
  });

  it("coalesces concurrent misses into a single loader call", async () => {
    let resolve!: (v: number) => void;
    const loader = vi.fn(() => new Promise<number>((res) => (resolve = res)));
    const c = caffeine<string, number>({ maximumSize: 100 }).buildAsync(loader);
    const p1 = c.get("k");
    const p2 = c.get("k");
    const p3 = c.get("k");
    resolve(42);
    expect(await Promise.all([p1, p2, p3])).toEqual([42, 42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("records load stats when enabled", async () => {
    const c = caffeine<string, number>({ maximumSize: 100 })
      .recordStats()
      .buildAsync(async () => 1);
    await c.get("a");
    await c.get("a"); // hit
    const s = c.stats();
    expect(s.loadSuccessCount).toBe(1);
    expect(s.loadFailureCount).toBe(0);
  });

  it("removes the pending entry and records failure on loader rejection", async () => {
    let calls = 0;
    const loader = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("fail");
      return "ok";
    });
    const c = caffeine<string, string>({ maximumSize: 100 }).recordStats().buildAsync(loader);
    await expect(c.get("a")).rejects.toThrow("fail");
    expect(await c.get("a")).toBe("ok");
    expect(c.stats().loadFailureCount).toBe(1);
    expect(c.stats().loadSuccessCount).toBe(1);
  });

  it("does not publish a value invalidated while its load was pending", async () => {
    let resolve!: (v: string) => void;
    const loader = () => new Promise<string>((res) => (resolve = res));
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);
    const p = c.get("a");
    c.invalidate("a");
    resolve("stale");
    expect(await p).toBe("stale");
    expect(c.getIfPresent("a")).toBeUndefined();
  });

  it("does not overwrite a value set while its load was pending", async () => {
    let resolve!: (v: string) => void;
    const loader = () => new Promise<string>((res) => (resolve = res));
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);
    const p = c.get("a");
    c.set("a", "fresh");
    resolve("stale");
    await p;
    expect(c.getIfPresent("a")).toBe("fresh");
  });

  it("refresh serves the old value until the new one resolves", async () => {
    let n = 0;
    const c = caffeine<string, number>({ maximumSize: 100 }).buildAsync(async () => ++n);
    expect(await c.get("a")).toBe(1);
    const rp = c.refresh("a");
    expect(c.getIfPresent("a")).toBe(1);
    expect(await rp).toBe(2);
    expect(c.getIfPresent("a")).toBe(2);
  });

  it("passes an AbortSignal that fires when a load is superseded", async () => {
    let captured: AbortSignal | undefined;
    let resolve!: (v: string) => void;
    const loader = (_k: string, signal?: AbortSignal) => {
      captured = signal;
      return new Promise<string>((res) => (resolve = res));
    };
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);
    const p = c.get("a");
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    c.invalidate("a");
    expect(captured!.aborted).toBe(true);
    resolve("x");
    await p;
  });

  it("does not publish a refresh after invalidateAll", async () => {
    let resolve!: (v: string) => void;
    let value = "initial";
    const loader = () => {
      const next = value;
      return new Promise<string>((res) => {
        resolve = () => res(next);
      });
    };
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);

    const first = c.get("a");
    resolve("initial");
    expect(await first).toBe("initial");

    value = "stale-refresh";
    const refresh = c.refresh("a");
    c.invalidateAll();
    resolve("stale-refresh");
    expect(await refresh).toBe("stale-refresh");
    expect(c.getIfPresent("a")).toBeUndefined();
  });

  it("bulkGet loads only missing keys via the bulk loader", async () => {
    const c = caffeine<string, number>({ maximumSize: 100 }).buildAsync(async () => -1);
    c.set("a", 1);
    const bulk = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, k.length])));
    const result = await c.bulkGet(["a", "bb", "ccc"], bulk);
    expect(result.get("a")).toBe(1);
    expect(result.get("bb")).toBe(2);
    expect(result.get("ccc")).toBe(3);
    expect(bulk).toHaveBeenCalledWith(["bb", "ccc"]);
  });

  it("bulkGet falls back to per-key loading and coalesces", async () => {
    const loader = vi.fn(async (k: string) => k.toUpperCase());
    const c = caffeine<string, string>({ maximumSize: 100 }).buildAsync(loader);
    const result = await c.bulkGet(["x", "y", "x"]);
    expect(result.get("x")).toBe("X");
    expect(result.get("y")).toBe("Y");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
