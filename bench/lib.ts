/** Shared benchmark helpers (zero-dependency). */

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function opsPerSec(ops: number, ms: number): string {
  return `${fmt(Math.round((ops / ms) * 1000))}/s`;
}

export function gc(): void {
  const g = globalThis as unknown as { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

export function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Deterministic LCG so runs are reproducible. */
export function lcg(seed = 0x2545f491): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Zipfian-ish skewed integer stream in [0, universe). */
export function zipfStream(
  count: number,
  universe: number,
  skew: number,
  rand: () => number = lcg(),
): Int32Array {
  const s = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    s[i] = Math.floor(universe * Math.pow(rand(), skew));
  }
  return s;
}

/** Sequential loop scan of `universe` keys repeated to `count` (scan-resistance). */
export function loopStream(count: number, universe: number): Int32Array {
  const s = new Int32Array(count);
  for (let i = 0; i < count; i++) s[i] = i % universe;
  return s;
}

/** One-hit-wonder stream: mostly unique keys with a small hot set mixed in. */
export function oneHitStream(
  count: number,
  hotSet: number,
  rand: () => number = lcg(),
): Int32Array {
  const s = new Int32Array(count);
  let unique = hotSet;
  for (let i = 0; i < count; i++) {
    s[i] = rand() < 0.2 ? Math.floor(rand() * hotSet) : unique++;
  }
  return s;
}

/** Bursty stream: alternating windows of a few hot keys (temporal locality). */
export function burstStream(
  count: number,
  windows: number,
  windowKeys: number,
  rand: () => number = lcg(),
): Int32Array {
  const s = new Int32Array(count);
  const per = Math.ceil(count / windows);
  for (let w = 0; w < windows; w++) {
    const base = w * windowKeys;
    for (let i = 0; i < per; i++) {
      const idx = w * per + i;
      if (idx >= count) break;
      s[idx] = base + Math.floor(rand() * windowKeys);
    }
  }
  return s;
}
