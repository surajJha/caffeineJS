import { describe, expect, it } from "vitest";
import { get } from "node:http";
import { caffeine } from "../src/index.js";
import { serveDashboard } from "../src/dashboard/server.js";

describe("dashboard server (CAFF-052)", () => {
  it("serves the UI and streams cache events via SSE", async () => {
    const cache = caffeine<string, number>({ maximumSize: 4 }).build();
    const server = await serveDashboard(cache, { port: 0 });

    try {
      const htmlRes = await fetch(server.url);
      expect(htmlRes.status).toBe(200);
      const html = await htmlRes.text();
      expect(html).toContain("caffeine-js dashboard");

      const events: string[] = [];
      let responseReady: () => void;
      const responsePromise = new Promise<void>((r) => (responseReady = r));

      const req = get(`${server.url}/events`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          events.push(chunk);
        });
        responseReady();
      });

      await responsePromise;

      cache.set("x", 1);
      cache.get("x");
      cache.get("missing");

      await new Promise((r) => setTimeout(r, 300));
      req.destroy();
      await server.stop();

      const payload = events.join("");
      expect(payload).toContain("data:");
      const parsed = payload
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()));
      const types = parsed.map((e) => e.type);
      expect(types).toContain("hit");
    } finally {
      // closed above; guard for early failure
      try {
        await server.stop();
      } catch {
        // ignore
      }
    }
  });
});
