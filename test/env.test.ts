import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monotonicNow, wallClockNow, hasBackgroundTimers } from "../src/env.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // The inspect subpath is intentionally Node-only (CLI/TUI).
    if (p.includes("src/inspect")) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("cross-runtime env (CAFF-030)", () => {
  it("exposes numeric time sources", () => {
    expect(typeof monotonicNow()).toBe("number");
    expect(typeof wallClockNow()).toBe("number");
    expect(typeof hasBackgroundTimers).toBe("boolean");
  });

  it("monotonicNow does not go backwards", () => {
    const a = monotonicNow();
    const b = monotonicNow();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("src imports no node:* built-ins and no setInterval for correctness", () => {
    const files = walk(join(process.cwd(), "src"));
    for (const f of files) {
      const code = readFileSync(f, "utf8");
      expect(code, `${f} must not import node:* built-ins`).not.toMatch(
        /from\s+["']node:/,
      );
      expect(code, `${f} must not require() node built-ins`).not.toMatch(
        /require\(["']node:/,
      );
      expect(code, `${f} must not rely on setInterval`).not.toMatch(
        /setInterval\s*\(/,
      );
    }
  });
});
