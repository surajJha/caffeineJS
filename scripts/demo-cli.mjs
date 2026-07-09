#!/usr/bin/env node
import { caffeine } from "../src/index.js";
import { attachInspector } from "../src/inspect/index.js";

const cache = caffeine({ maximumSize: 200, recordStats: true, adaptive: true }).build();
const { stop } = attachInspector(cache, { interval: 500, includeKeys: false });

console.log("CLI inspector running. In a TTY this redraws the screen; here it prints snapshots.\n");

let i = 0;
const interval = setInterval(() => {
  const base = Math.floor(i / 40) * 30;
  for (let j = 0; j < 40; j++) {
    const key = base + (j % 30);
    if (cache.get(key) === undefined) cache.set(key, i);
  }
  i++;
}, 150);

setTimeout(() => {
  clearInterval(interval);
  stop();
  console.log("\nCLI inspector stopped.");
  process.exit(0);
}, 5000);
