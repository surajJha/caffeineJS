/**
 * Cloudflare Workers smoke. Verifies the bundle imports and runs inside the
 * Workers runtime (no node:* built-ins, no setInterval reliance).
 *
 * Run locally with miniflare/wrangler:
 *   npx wrangler dev scripts/smoke-worker.mjs
 * or in CI via `unstable_dev`.
 */
import { caffeine } from "../dist/index.mjs";

export default {
  async fetch() {
    const cache = caffeine({ maximumSize: 100 }).recordStats().build();
    cache.set("a", 1);
    cache.get("a");
    cache.runMaintenance();
    const ok = cache.get("a") === 1 && cache.size === 1;
    return new Response(ok ? "smoke:worker OK" : "smoke:worker FAILED", {
      status: ok ? 200 : 500,
    });
  },
};
