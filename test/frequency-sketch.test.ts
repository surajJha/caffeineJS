import { describe, it, expect } from "vitest";
import { FrequencySketch } from "../src/policy/frequency-sketch.js";

describe("FrequencySketch", () => {
  it("estimates frequency monotonically up to saturation", () => {
    const s = new FrequencySketch(512, false);
    const h = 123456;
    expect(s.frequency(h)).toBe(0);
    let last = 0;
    for (let i = 0; i < 30; i++) {
      s.increment(h);
      const f = s.frequency(h);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    expect(last).toBe(15); // saturates
  });

  it("separates hot from cold keys", () => {
    const s = new FrequencySketch(512, false);
    const hot = 111;
    const cold = 222;
    for (let i = 0; i < 20; i++) s.increment(hot);
    s.increment(cold);
    expect(s.frequency(hot)).toBeGreaterThan(s.frequency(cold));
  });

  it("doorkeeper gives first-seen keys frequency >= 1", () => {
    const s = new FrequencySketch(512, true);
    const h = 999;
    expect(s.frequency(h)).toBe(0);
    s.increment(h); // first sighting -> doorkeeper only
    expect(s.frequency(h)).toBe(1);
  });

  it("ages (halves) counters after the sample fills", () => {
    const width = 8; // capacity < 8 clamps to 8; sampleSize = width*10 = 80
    const s = new FrequencySketch(width, false);
    const h = 42;
    for (let i = 0; i < 15; i++) s.increment(h); // saturate at 15
    expect(s.frequency(h)).toBe(15);
    // Drive enough increments (on other keys) to trigger a reset.
    for (let i = 0; i < 200; i++) s.increment(i);
    // After at least one aging pass, the hot key must have decayed below 15.
    expect(s.frequency(h)).toBeLessThan(15);
  });
});
