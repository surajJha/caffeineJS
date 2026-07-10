import worker from "./smoke-worker.mjs";

const res = await worker.fetch(new Request("https://example.test/"));
const body = await res.text();

if (res.status !== 200 || !body.includes("OK")) {
  console.error(`[smoke:worker] FAILED status=${res.status} body=${body}`);
  process.exit(1);
}

console.log(`[smoke:worker] ${body}`);
