import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { caffeine } from "../src/index.js";

describe("invariants (property-based)", () => {
  it("never exceeds capacity and stays consistent under random ops", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant("set"), key: fc.integer({ min: 0, max: 40 }) }),
            fc.record({ op: fc.constant("get"), key: fc.integer({ min: 0, max: 40 }) }),
            fc.record({ op: fc.constant("del"), key: fc.integer({ min: 0, max: 40 }) }),
          ),
          { maxLength: 500 },
        ),
        (cap, ops) => {
          const c = caffeine<number, number>({ maximumSize: cap }).build();
          const oracle = new Set<number>();
          for (const o of ops) {
            if (o.op === "set") {
              c.set(o.key, o.key);
              oracle.add(o.key);
            } else if (o.op === "get") {
              c.get(o.key);
            } else {
              c.delete(o.key);
              oracle.delete(o.key);
            }
            // Size never exceeds capacity.
            expect(c.size).toBeLessThanOrEqual(cap);
            // Keys reported are consistent with has() and are a subset of ever-set keys.
            let counted = 0;
            for (const k of c.keys()) {
              counted++;
              expect(c.has(k)).toBe(true);
              expect(oracle.has(k)).toBe(true);
            }
            expect(counted).toBe(c.size);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("recently-set keys within capacity are retained (no premature eviction)", () => {
    const cap = 100;
    const c = caffeine<number, number>({ maximumSize: cap }).build();
    for (let i = 0; i < cap; i++) c.set(i, i);
    // All fit exactly; nothing should have been evicted.
    expect(c.size).toBe(cap);
    for (let i = 0; i < cap; i++) expect(c.has(i)).toBe(true);
  });
});

describe("hit-ratio quality", () => {
  it("beats a naive FIFO on a Zipfian-ish skewed workload", () => {
    const cap = 500;
    const universe = 5000;
    const ops = 50_000;

    // Skewed key generator: many hits concentrate on low ids.
    const nextKey = () => Math.floor(universe * Math.pow(Math.random(), 3));

    const wtiny = caffeine<number, number>({ maximumSize: cap }).recordStats().build();

    // Reference FIFO cache.
    const fifo = new Map<number, number>();
    let fifoHits = 0;
    const fifoGetSet = (k: number) => {
      if (fifo.has(k)) {
        fifoHits++;
        return;
      }
      fifo.set(k, k);
      if (fifo.size > cap) {
        const oldest = fifo.keys().next().value as number;
        fifo.delete(oldest);
      }
    };

    for (let i = 0; i < ops; i++) {
      const k = nextKey();
      if (wtiny.get(k) === undefined) wtiny.set(k, k);
      fifoGetSet(k);
    }

    const wRate = wtiny.stats().hitRate;
    const fifoRate = fifoHits / ops;
    expect(wRate).toBeGreaterThan(fifoRate);
  });
});
