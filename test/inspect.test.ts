import { describe, expect, it } from "vitest";
import { caffeine } from "../src/index.js";
import { Aggregator, attachInspector } from "../src/inspect/index.js";
import type { CacheEvent } from "../src/index.js";

describe("inspect aggregator + CLI (CAFF-051)", () => {
  it("aggregates hits, misses, and occupancy", () => {
    const agg = new Aggregator({ recentSize: 10, rollingWindow: 10 });
    const occupancy = {
      windowWeight: 1,
      probationWeight: 0,
      protectedWeight: 0,
      weightedSize: 1,
      windowMax: 10,
      protectedMax: 7,
    };
    const hit = {
      type: "hit" as const,
      key: "a",
      segment: "window" as const,
      freq: 3,
      occupancy,
    };
    const miss = { type: "miss" as const, key: "b", occupancy };
    agg.ingest(hit as unknown as CacheEvent<unknown, unknown>);
    agg.ingest(hit as unknown as CacheEvent<unknown, unknown>);
    agg.ingest(miss as unknown as CacheEvent<unknown, unknown>);

    const s = agg.snapshot();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe(2 / 3);
    expect(s.freqHistogram[3]).toBe(2);
    expect(s.occupancy.windowWeight).toBe(1);
  });

  it("attachInspector starts, observes, and stops without throwing", async () => {
    const cache = caffeine<string, number>({ maximumSize: 50 }).build();
    const inspector = attachInspector(cache, { refreshMs: 50 });

    cache.set("a", 1);
    cache.get("a");
    cache.get("b");

    await new Promise((r) => setTimeout(r, 120));
    expect(() => inspector.stop()).not.toThrow();
    expect(cache.get("a")).toBe(1);
  });
});
