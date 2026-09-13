import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualClock } from "@/lib/clock";
import { DEMO_VIDEOS, SEED_STEPS, seedDemoData } from "@/lib/demo/seed";
import { createMemoryStore } from "@/lib/store/memory";
import { VIDEO_SCRIPT_MAX_LENGTH, VIDEO_TITLE_MAX_LENGTH } from "@/lib/store/types";

const GLOBAL_KEY = Symbol.for("segue.demoStore");
const DASHES = /[‐-―−-]/;

function clearGlobal() {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
}

beforeEach(() => {
  clearGlobal();
  vi.resetModules();
});

afterEach(() => {
  clearGlobal();
});

describe("demo seed data", () => {
  it("has three videos on different topics with exactly one monitored", () => {
    expect(DEMO_VIDEOS).toHaveLength(3);
    expect(new Set(DEMO_VIDEOS.map((video) => video.title)).size).toBe(3);
    expect(DEMO_VIDEOS.filter((video) => video.monitoring)).toHaveLength(1);
  });

  it("has full multi paragraph scripts of a few hundred words", () => {
    for (const video of DEMO_VIDEOS) {
      const paragraphs = video.script.split("\n\n");
      const words = video.script.split(/\s+/).filter(Boolean);
      expect(paragraphs.length).toBeGreaterThanOrEqual(4);
      expect(words.length).toBeGreaterThanOrEqual(250);
      expect(video.script.length).toBeLessThanOrEqual(VIDEO_SCRIPT_MAX_LENGTH);
      expect(video.title.length).toBeLessThanOrEqual(VIDEO_TITLE_MAX_LENGTH);
    }
  });

  it("uses no dash characters", () => {
    for (const video of DEMO_VIDEOS) {
      expect(video.title).not.toMatch(DASHES);
      expect(video.script).not.toMatch(DASHES);
    }
  });

  it("writes every seed step through the Store and returns to real time", async () => {
    const clock = createManualClock(new Date("2026-09-13T12:00:00.000Z"));
    let travel: Date | null = null;
    const store = createMemoryStore({ clock: { now: () => travel ?? clock.now() } });
    const travelTo = vi.fn((date: Date | null) => {
      travel = date;
    });
    await seedDemoData({ store, now: clock.now(), travelTo });

    const videos = await store.listVideos();
    expect(videos.map((video) => video.title).sort()).toEqual(DEMO_VIDEOS.map((video) => video.title).sort());
    expect(await store.countMonitoredVideos()).toBe(1);
    const oldest = videos.find((video) => video.title === DEMO_VIDEOS[0].title);
    expect(oldest?.createdAt).toEqual(new Date("2026-09-01T12:00:00.000Z"));
    expect(travelTo).toHaveBeenLastCalledWith(null);
    expect(SEED_STEPS.length).toBeGreaterThanOrEqual(1);
  });

  it("returns to real time even when a step fails", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "createVideo").mockRejectedValueOnce(new Error("boom"));
    const travelTo = vi.fn();
    await expect(seedDemoData({ store, now: new Date(), travelTo })).rejects.toThrow("boom");
    expect(travelTo).toHaveBeenLastCalledWith(null);
  });
});

describe("demo store", () => {
  it("seeds once and shares one store across calls and module reloads", async () => {
    const first = await import("@/lib/demo/store");
    const store = await first.getDemoStore();
    expect(await first.getDemoStore()).toBe(store);
    expect(await store.listVideos()).toHaveLength(3);

    await store.createVideo({ title: "Added in demo", script: "" });
    vi.resetModules();
    const reloaded = await import("@/lib/demo/store");
    const again = await reloaded.getDemoStore();
    expect(again).toBe(store);
    expect(await again.listVideos()).toHaveLength(4);
  });

  it("places seeded rows in the past and new rows at the current time", async () => {
    const { getDemoStore } = await import("@/lib/demo/store");
    const store = await getDemoStore();
    const before = Date.now();
    const created = await store.createVideo({ title: "Now", script: "" });
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    const seeded = (await store.listVideos()).filter((video) => video.id !== created.id);
    for (const video of seeded) {
      expect(video.createdAt.getTime()).toBeLessThan(before - 24 * 60 * 60 * 1000);
    }
  });

  it("names a reserved demo owner address", async () => {
    const { DEMO_OWNER_EMAIL } = await import("@/lib/demo/store");
    expect(DEMO_OWNER_EMAIL).toMatch(/@example\.com$/);
  });
});
