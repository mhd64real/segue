import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualClock } from "@/lib/clock";
import { DEMO_SPONSORSHIPS, DEMO_VIDEOS, SEED_STEPS, insertSegment, seedDemoData } from "@/lib/demo/seed";
import { createMemoryStore } from "@/lib/store/memory";
import { VIDEO_DELETED_REASON, VIDEO_SCRIPT_MAX_LENGTH, VIDEO_TITLE_MAX_LENGTH } from "@/lib/store/types";

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

  it("seeds branches in several states, with one sent reply that blocks deleting its video", async () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    let travel: Date | null = null;
    const store = createMemoryStore({ clock: { now: () => travel ?? now } });
    await seedDemoData({
      store,
      now,
      travelTo: (date) => {
        travel = date;
      },
    });

    const videos = await store.listVideos();
    const byTitle = (title: string) => videos.find((video) => video.title === title)!;
    const [wifi, castIron, hiking] = DEMO_VIDEOS.map((video) => byTitle(video.title));
    expect([wifi.branchCount, castIron.branchCount, hiking.branchCount]).toEqual([2, 1, 0]);

    const wifiBranches = await store.listBranchesForVideo(wifi.id);
    expect(wifiBranches.map((branch) => [branch.brand, branch.status])).toEqual([
      ["Keystone VPN", "pending"],
      ["Meshwave", "approved"],
    ]);
    const sentDraft = await store.getEmailDraftByBranchId(wifiBranches[1].id);
    expect(sentDraft).toMatchObject({ status: "sent", kind: "accept", subject: "Re: Paid integration in your WiFi video" });
    expect(sentDraft?.sentAt?.getTime()).toBeLessThan(now.getTime());
    expect((await store.listSponsorships()).map((sponsorship) => sponsorship.status)).toEqual([
      "branched",
      "branched",
      "branched",
    ]);
    expect(await store.countUnreadNotifications()).toBe(2);

    const branch = await store.getBranch(wifiBranches[1].id);
    expect(branch?.baseScript).toBe(DEMO_VIDEOS[0].script);
    expect(branch?.script).toContain("sponsored by Meshwave");

    expect(await store.hasSendingOrSentReply(wifi.id)).toBe(true);
    expect(await store.hasSendingOrSentReply(castIron.id)).toBe(false);
    expect(await store.deleteVideo(wifi.id)).toBe("reply_sent");
    expect(await store.deleteVideo(castIron.id)).toBe("deleted");
    const hearth = (await store.listSponsorships()).find((sponsorship) => sponsorship.brand === "Hearth and Field");
    expect(hearth).toMatchObject({ status: "no_fit", fitReason: VIDEO_DELETED_REASON, videoId: null });
  });

  it("uses no dash characters and only reserved example addresses in sponsorship data", () => {
    for (const seed of DEMO_SPONSORSHIPS) {
      const texts = [
        seed.segment,
        seed.segmentSummary,
        seed.fitReason,
        seed.decision?.replyBody ?? "",
        ...Object.entries(seed.email)
          .filter(([key]) => key !== "gmailMessageId" && key !== "threadId")
          .flatMap(([, value]) => (Array.isArray(value) ? value : [String(value)])),
      ];
      for (const text of texts) {
        expect(text).not.toMatch(DASHES);
      }
      for (const address of [seed.email.fromEmail, seed.email.replyTo, ...seed.email.cc].filter(Boolean)) {
        expect(address).toMatch(/@[a-z]+\.example$/);
      }
      expect(seed.segment).toMatch(/sponsored by/i);
    }
  });

  it("inserts a segment after a paragraph, or at the end when the paragraph is past the end", () => {
    expect(insertSegment("A\n\nB\n\nC", 0, "S")).toBe("A\n\nS\n\nB\n\nC");
    expect(insertSegment("A\n\nB", 1, "S")).toBe("A\n\nB\n\nS");
    expect(insertSegment("A", 9, "S")).toBe("A\n\nS");
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
