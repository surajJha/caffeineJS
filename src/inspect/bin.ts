#!/usr/bin/env node
/**
 * Demo binary for the caffeine-js CLI inspector.
 *
 * Creates a small cache and drives it with a synthetic Zipfian workload so you
 * can see the W-TinyLFU admission gate in action without writing any code.
 *
 * Usage:
 *   npx caffeine-inspect
 */
import { caffeine } from "../index.js";
import { attachInspector } from "./cli.js";

const CAPACITY = 200;
const SKEW = 2;

const cache = caffeine<number, number>({ maximumSize: CAPACITY }).build();
const inspector = attachInspector(cache, { refreshMs: 200 });

function zipfian(max: number, skew: number): number {
  return Math.floor(max * Math.pow(Math.random(), skew));
}

let running = true;
process.on("SIGINT", () => {
  running = false;
  inspector.stop();
  process.exit(0);
});

function tick(): void {
  if (!running) return;
  // Burst of reads.
  for (let b = 0; b < 200; b++) {
    const k = zipfian(CAPACITY * 5, SKEW);
    if (cache.get(k) === undefined) {
      cache.set(k, k);
    }
  }
  setImmediate(tick);
}

console.log("caffeine-inspect running. Press Ctrl+C to stop.");
tick();
