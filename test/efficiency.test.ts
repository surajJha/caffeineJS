import { describe, expect, it } from "vitest";
import { LRUCache } from "lru-cache";
import { caffeine } from "../src/index.js";
import { burstStream, loopStream, oneHitStream, zipfStream } from "../bench/lib.js";

/**
 * CAFF-040 — Efficiency validation vs Caffeine / LRU claims.
 *
 * These are regression guards, not tuned benchmarks. We assert that
 * caffeine-js is at least competitive with lru-cache on a variety of
 * synthetic traces and wins on frequency-skewed / scan-resistant workloads.
 */
describe("efficiency validation (CAFF-040)", () => {
  const CAPACITY = 1_000;

  function trace(name: string, stream: Int32Array, tolerance = 0.0): void {
    it(`${name} — caffeine hit-rate ≥ lru-cache (${tolerance >= 0 ? "minus" : "plus"} ${Math.abs(tolerance)})`, () => {
      const cache = caffeine<number, number>({ maximumSize: CAPACITY }).recordStats().build();
      const lru = new LRUCache<number, number>({ max: CAPACITY });
      let lruHits = 0;
      let lruMisses = 0;

      for (let i = 0; i < stream.length; i++) {
        const k = stream[i] as number;
        if (cache.get(k) === undefined) cache.set(k, k);
        if (lru.has(k)) {
          lruHits++;
          lru.get(k);
        } else {
          lruMisses++;
          lru.set(k, k);
        }
      }

      const cRate = cache.stats().hitRate;
      const lRate = lruHits + lruMisses === 0 ? 0 : lruHits / (lruHits + lruMisses);
      expect(cRate, `caffeine=${cRate.toFixed(3)} lru=${lRate.toFixed(3)}`).toBeGreaterThanOrEqual(
        lRate - tolerance,
      );
    });
  }

  trace("zipfian skew=2", zipfStream(50_000, CAPACITY * 10, 2), 0.0);
  trace("zipfian skew=3", zipfStream(50_000, CAPACITY * 10, 3), 0.0);
  trace("loop scan (scan resistance)", loopStream(50_000, CAPACITY * 5), 0.0);
  trace("one-hit-wonder (doorkeeper)", oneHitStream(50_000, 50), 0.0);
  // Bursty / recency-heavy workloads are where LRU can edge ahead; we allow a
  // small tolerance so the hill-climber has room to adapt.
  trace("bursty recency", burstStream(50_000, 50, 20), 0.03);
});
