// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { caffeine } from "../src/index.js";
import { renderDashboard } from "../src/dashboard/index.js";

describe("dashboard browser (CAFF-052)", () => {
  it("renders into a container and updates on cache operations", () => {
    const cache = caffeine<string, number>({ maximumSize: 4 }).build();
    const container = document.createElement("div");
    const cleanup = renderDashboard(container, cache);

    expect(container.querySelector(".caffeine-dashboard")).toBeTruthy();

    cache.set("a", 1);
    cache.get("a");
    cache.get("missing");

    const ops = container.querySelector(".ops");
    expect(Number(ops?.textContent)).toBeGreaterThanOrEqual(2);

    const logItems = container.querySelectorAll(".caffeine-log li");
    expect(logItems.length).toBeGreaterThan(0);

    cleanup();
    expect(container.innerHTML).toBe("");
  });
});
