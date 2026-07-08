/**
 * Cloudflare Workers smoke via wrangler's in-process test server (miniflare).
 * `node scripts/smoke-worker.test.mjs` — spins the Worker, hits it, asserts 200.
 */
import { unstable_dev } from "wrangler";

const worker = await unstable_dev("scripts/smoke-worker.mjs", {
  experimental: { disableExperimentalWarning: true },
});

try {
  const res = await worker.fetch("http://example.com/");
  const body = await res.text();
  if (res.status !== 200 || !body.includes("OK")) {
    console.error(`[smoke:worker] FAILED status=${res.status} body=${body}`);
    process.exit(1);
  }
  console.log(`[smoke:worker] ${body}`);
} finally {
  await worker.stop();
}
