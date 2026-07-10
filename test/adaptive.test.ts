import { describe, it, expect } from "vitest";
import { caffeine } from "../src/index.js";

/** Deterministic LCG so the traces are reproducible across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function hitRate(trace: Int32Array, cap: number, adaptive: boolean): number {
  const c = caffeine<number, number>({ maximumSize: cap, adaptive }).recordStats().build();
  for (let i = 0; i < trace.length; i++) {
    const k = trace[i] as number;
    if (c.get(k) === undefined) c.set(k, k);
  }
  return c.stats().hitRate;
}

/** A recency-shifting workload: the hot key span slides forward over time. */
function shiftTrace(len: number, hotSpan: number, drift: number, seed: number): Int32Array {
  const rnd = lcg(seed);
  const t = new Int32Array(len);
  let base = 0;
  for (let i = 0; i < len; i++) {
    if (rnd() < 0.85) t[i] = base + Math.floor(rnd() * hotSpan);
    else t[i] = base + hotSpan + Math.floor(rnd() * hotSpan * 8);
    if (i % drift === 0) base += 1;
  }
  return t;
}

describe("adaptive window (CAFF-041)", () => {
  it("beats a static window on recency-shifting workloads", () => {
    const cap = 500;
    const trace = shiftTrace(200_000, Math.floor(cap * 0.6), 3, 12345);
    const staticRate = hitRate(trace, cap, false);
    const adaptiveRate = hitRate(trace, cap, true);
    // The sliding hot set rewards a larger admission window; the climber should
    // find it and deliver a clear improvement over the fixed ~1% window.
    expect(adaptiveRate).toBeGreaterThan(staticRate + 0.05);
  });

  it("does not meaningfully regress on a stable frequency-skewed workload", () => {
    const cap = 500;
    const rnd = lcg(999);
    const trace = new Int32Array(200_000);
    for (let i = 0; i < trace.length; i++) {
      trace[i] = Math.floor(cap * 5 * Math.pow(rnd(), 3)); // zipfian-ish
    }
    const staticRate = hitRate(trace, cap, false);
    const adaptiveRate = hitRate(trace, cap, true);
    // Online exploration has a small bounded cost; stay within noise of static.
    expect(adaptiveRate).toBeGreaterThan(staticRate - 0.02);
  });

  it("keeps a fixed window and stays within capacity when disabled", () => {
    const cap = 500;
    const c = caffeine<number, number>({ maximumSize: cap, adaptive: false }).build();
    for (let i = 0; i < 50_000; i++) {
      c.set(i, i);
      c.get(i % 1000);
      expect(c.size).toBeLessThanOrEqual(cap);
    }
  });
});
