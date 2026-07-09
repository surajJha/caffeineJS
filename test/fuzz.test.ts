import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { caffeine } from "../src/index.js";

describe("fuzz & stress (CAFF-042)", () => {
  const keySpace = fc.integer({ min: 0, max: 15 });
  const valueSpace = fc.integer({ min: 0, max: 100 });

  type Op =
    | { type: "set"; key: number; value: number; weight: number }
    | { type: "get"; key: number }
    | { type: "delete"; key: number }
    | { type: "clear" }
    | { type: "advance"; ms: number };

  const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ type: fc.constant("set" as const), key: keySpace, value: valueSpace, weight: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ type: fc.constant("get" as const), key: keySpace }),
    fc.record({ type: fc.constant("delete" as const), key: keySpace }),
    fc.record({ type: fc.constant("clear" as const) }),
    fc.record({ type: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 100 }) }),
  );

  function totalWeight(
    cache: ReturnType<ReturnType<typeof caffeine<number, { value: number; weight: number }>>["build"]>,
  ): number {
    let w = 0;
    for (const [, v] of cache.entries()) w += v.weight ?? 1;
    return w;
  }

  it("count-bounded cache never exceeds capacity and remains consistent", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 50, maxLength: 300 }), (ops) => {
        const cache = caffeine<number, { value: number; weight: number }>({
          maximumSize: 8,
        }).build();

        for (const op of ops) {
          switch (op.type) {
            case "set":
              cache.set(op.key, { value: op.value, weight: op.weight });
              break;
            case "get":
              cache.get(op.key);
              break;
            case "delete":
              cache.delete(op.key);
              break;
            case "clear":
              cache.clear();
              break;
            case "advance":
              cache.runMaintenance();
              break;
          }
          expect(cache.size).toBeLessThanOrEqual(8);
          expect(cache.size).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("weight-bounded cache respects its weight budget", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 50, maxLength: 300 }), (ops) => {
        const cache = caffeine<number, { value: number; weight: number }>({
          maximumWeight: 16,
          weigher: (_, v) => v.weight,
        }).build();

        for (const op of ops) {
          switch (op.type) {
            case "set":
              cache.set(op.key, { value: op.value, weight: op.weight });
              break;
            case "get":
              cache.get(op.key);
              break;
            case "delete":
              cache.delete(op.key);
              break;
            case "clear":
              cache.clear();
              break;
            case "advance":
              cache.runMaintenance();
              break;
          }
          expect(totalWeight(cache)).toBeLessThanOrEqual(16);
          expect(cache.size).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("TTL cache expires entries after a deterministic clock advance", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { minLength: 20, maxLength: 150 }), (ops) => {
        let now = 0;
        const cache = caffeine<number, number>({
          maximumSize: 8,
          expireAfterWrite: 100,
          clock: () => now,
        }).build();

        for (const op of ops) {
          switch (op.type) {
            case "set":
              cache.set(op.key, op.value);
              break;
            case "get":
              cache.get(op.key);
              break;
            case "delete":
              cache.delete(op.key);
              break;
            case "clear":
              cache.clear();
              break;
            case "advance":
              now += op.ms;
              cache.runMaintenance();
              break;
          }
          expect(cache.size).toBeLessThanOrEqual(8);
        }

        // After a large deterministic advance, no write can still be alive.
        now += 200;
        cache.runMaintenance();
        expect(cache.size).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
