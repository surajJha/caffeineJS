/**
 * CAFF-041 adaptive-window validation.
 *
 * Compares hit ratio with adaptive hill-climbing ON vs a fixed ~1% window,
 * across two trace families:
 *   1. Zipfian (frequency-skewed) — textbook TinyLFU territory; adaptive must
 *      not regress here.
 *   2. Recency-shifting — the hot set drifts over time, so a larger admission
 *      window pays off; adaptive should climb toward it and win.
 *
 * Run: node --import tsx bench/adaptive.ts
 */
import { caffeine } from "../src/index.js";

function measure(
  trace: Int32Array,
  cap: number,
  adaptive: boolean,
): { hitRate: number; windowMax: number } {
  const c = caffeine<number, number>({ maximumSize: cap, adaptive }).recordStats().build();
  for (let i = 0; i < trace.length; i++) {
    const k = trace[i] as number;
    if (c.get(k) === undefined) c.set(k, k);
  }
  // Reach into the policy for the tuned window size (validation only).
  const windowMax = (c as unknown as { policy: { windowMaximum: number } }).policy.windowMaximum;
  return { hitRate: c.stats().hitRate, windowMax };
}

/** Zipfian-ish skewed stream: a few keys dominate, stable over time. */
function zipfTrace(len: number, universe: number, skew: number): Int32Array {
  const t = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    t[i] = Math.floor(universe * Math.pow(Math.random(), skew));
  }
  return t;
}

/**
 * Recency-shifting stream: the hot window of keys slides forward over time, so
 * recently-seen keys are the best predictor of the near future (favors a bigger
 * admission window over pure frequency).
 */
function shiftTrace(len: number, hotSpan: number, drift: number): Int32Array {
  const t = new Int32Array(len);
  let base = 0;
  for (let i = 0; i < len; i++) {
    // 85% of accesses hit the current sliding hot span, 15% are cold noise.
    if (Math.random() < 0.85) {
      t[i] = base + Math.floor(Math.random() * hotSpan);
    } else {
      t[i] = base + hotSpan + Math.floor(Math.random() * hotSpan * 8);
    }
    if ((i & (drift - 1)) === 0) base += 1; // slide the hot set forward
  }
  return t;
}

function row(name: string, cap: number, off: number, on: number, win: number): void {
  const delta = ((on - off) * 100).toFixed(2);
  const sign = on >= off ? "+" : "";
  console.log(
    name.padEnd(22),
    `static=${off.toFixed(4)}`.padEnd(16),
    `adaptive=${on.toFixed(4)}`.padEnd(18),
    `Δ=${sign}${delta}pp`.padEnd(14),
    `window: ${((cap * 0.01) | 0).toLocaleString()} → ${win.toLocaleString()} (${((win / cap) * 100).toFixed(1)}%)`,
  );
}

function main(): void {
  const cap = 10_000;
  const len = 3_000_000;
  console.log(
    `\nCAFF-041 adaptive validation — cap=${cap.toLocaleString()}, trace=${len.toLocaleString()}\n`,
  );

  const zipf = zipfTrace(len, cap * 10, 3);
  const zA = measure(zipf, cap, true);
  row("zipfian(skew=3)", cap, measure(zipf, cap, false).hitRate, zA.hitRate, zA.windowMax);

  const zipf2 = zipfTrace(len, cap * 5, 2);
  const z2A = measure(zipf2, cap, true);
  row("zipfian(skew=2)", cap, measure(zipf2, cap, false).hitRate, z2A.hitRate, z2A.windowMax);

  const shift = shiftTrace(len, Math.floor(cap * 0.6), 8);
  const sA = measure(shift, cap, true);
  row("recency-shift", cap, measure(shift, cap, false).hitRate, sA.hitRate, sA.windowMax);

  console.log("");
}

main();
