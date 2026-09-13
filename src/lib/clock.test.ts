import { describe, expect, it } from "vitest";
import { createManualClock, systemClock } from "@/lib/clock";

describe("clocks", () => {
  it("system clock returns the current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("manual clock advances, sets and steps", () => {
    const clock = createManualClock(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    clock.set(new Date("2027-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2027-01-01T00:00:00.000Z");

    const stepping = createManualClock(new Date("2026-01-01T00:00:00.000Z"), 5);
    expect(stepping.now().getTime()).toBeLessThan(stepping.now().getTime());
  });

  it("returns a new Date each time", () => {
    const clock = createManualClock();
    const first = clock.now();
    first.setTime(0);
    expect(clock.now().getTime()).not.toBe(0);
  });
});
