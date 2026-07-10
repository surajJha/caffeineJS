#!/usr/bin/env node
// Run after `npm run build` so the demos exercise the published artifacts.
import { caffeine } from "../dist/index.mjs";
import { serveDashboard } from "../dist/dashboard/server.mjs";

const cache = caffeine({ maximumSize: 200, recordStats: true, adaptive: true }).build();
const server = await serveDashboard(cache, { port: 8765 });

console.log(`\n  Dashboard UI: ${server.url}\n  Open it in a browser. Press Ctrl+C to stop.\n`);

let i = 0;
const interval = setInterval(() => {
  // A shifting hot set so the admission gate, segment occupancy, and hit-rate move.
  const base = Math.floor(i / 40) * 30;
  for (let j = 0; j < 40; j++) {
    const key = base + (j % 30);
    if (cache.get(key) === undefined) cache.set(key, i);
  }
  i++;
}, 150);

process.on("SIGINT", async () => {
  clearInterval(interval);
  await server.stop();
  console.log("\nDashboard stopped.");
  process.exit(0);
});
