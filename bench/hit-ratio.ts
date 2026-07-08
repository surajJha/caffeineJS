/**
 * CAFF-034 hit-ratio harness.
 *
 * Replays several access patterns and reports hit ratio for caffeine-js vs
 * reference LRU, LFU, and FIFO policies. Proves the W-TinyLFU efficiency claim:
 * caffeine-js should match or beat LRU everywhere and win big on skewed /
 * scan-heavy / one-hit-wonder workloads.
 *
 * Run: npm run bench:hitratio
 */
import { caffeine } from "../src/index.js";
import { zipfStream, loopStream, oneHitStream, burstStream } from "./lib.js";

// --- Reference policies (minimal, for hit-ratio comparison only) ---

class Lru {
  private m = new Map<number, number>();
  constructor(private cap: number) {}
  access(k: number): boolean {
    if (this.m.has(k)) {
      const v = this.m.get(k)!;
      this.m.delete(k);
      this.m.set(k, v);
      return true;
    }
    this.m.set(k, 1);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as number);
    return false;
  }
}

class Fifo {
  private m = new Map<number, number>();
  constructor(private cap: number) {}
  access(k: number): boolean {
    if (this.m.has(k)) return true;
    this.m.set(k, 1);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as number);
    return false;
  }
}

class Lfu {
  private freq = new Map<number, number>();
  constructor(private cap: number) {}
  access(k: number): boolean {
    if (this.freq.has(k)) {
      this.freq.set(k, (this.freq.get(k) as number) + 1);
      return true;
    }
    if (this.freq.size >= this.cap) {
      let min = Infinity;
      let victim = -1;
      for (const [key, f] of this.freq) {
        if (f < min) {
          min = f;
          victim = key;
        }
      }
      if (victim !== -1) this.freq.delete(victim);
    }
    this.freq.set(k, 1);
    return false;
  }
}

function ratioRef(policy: { access: (k: number) => boolean }, stream: Int32Array): number {
  let hits = 0;
  for (let i = 0; i < stream.length; i++) if (policy.access(stream[i] as number)) hits++;
  return hits / stream.length;
}

function ratioCaffeine(cap: number, stream: Int32Array): number {
  const c = caffeine<number, number>({ maximumSize: cap }).recordStats().build();
  for (let i = 0; i < stream.length; i++) {
    const k = stream[i] as number;
    if (c.get(k) === undefined) c.set(k, 1);
  }
  return c.stats().hitRate;
}

function run(name: string, cap: number, stream: Int32Array): void {
  const caf = ratioCaffeine(cap, stream);
  const lru = ratioRef(new Lru(cap), stream);
  const lfu = ratioRef(new Lfu(cap), stream);
  const fifo = ratioRef(new Fifo(cap), stream);
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
  console.log(
    `${name.padEnd(20)} caffeine=${pct(caf)}  lru=${pct(lru)}  lfu=${pct(lfu)}  fifo=${pct(fifo)}`,
  );
}

function main(): void {
  const cap = 5_000;
  const n = 200_000;
  console.log(`\nHit ratio — cap=${cap.toLocaleString()} accesses=${n.toLocaleString()}\n`);
  run("zipf(skew=1)", cap, zipfStream(n, 200_000, 1));
  run("zipf(skew=2)", cap, zipfStream(n, 200_000, 2));
  run("zipf(skew=3)", cap, zipfStream(n, 200_000, 3));
  run("loop-scan", cap, loopStream(n, cap * 2));
  run("one-hit-wonder", cap, oneHitStream(n, cap));
  run("bursty", cap, burstStream(n, 50, cap));
  console.log("");
}

main();
