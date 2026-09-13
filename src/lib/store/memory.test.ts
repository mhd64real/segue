import { describe, expect, it } from "vitest";
import { createManualClock } from "@/lib/clock";
import { describeStoreContract } from "@/lib/store/contract";
import { createMemoryStore } from "@/lib/store/memory";
import { LEASE_SECONDS } from "@/lib/store/types";

describeStoreContract("memory", async () => {
  const clock = createManualClock(new Date("2026-09-01T00:00:00.000Z"), 1);
  let sequence = 0;
  const store = createMemoryStore({
    clock,
    generateId: () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`,
  });
  return {
    store,
    tag: "contract-",
    now: () => clock.now(),
    expireLeases: async () => clock.advance(LEASE_SECONDS * 1000 + 1000),
    setBranchStatus: async (branchId, status) => store.testing.setBranchStatus(branchId, status),
    cleanup: async () => {},
  };
});

describe("memory store", () => {
  it("uses injected ids and the injected clock", async () => {
    const clock = createManualClock(new Date("2026-02-03T04:05:06.000Z"));
    let n = 0;
    const store = createMemoryStore({ clock, generateId: () => `id-${(n += 1)}` });
    const video = await store.createVideo({ title: "First", script: "" });
    expect(video.id).toBe("id-1");
    expect(video.createdAt).toEqual(new Date("2026-02-03T04:05:06.000Z"));
    clock.advance(60_000);
    const updated = await store.updateVideo(video.id, { title: "Renamed" });
    expect(updated?.updatedAt).toEqual(new Date("2026-02-03T04:06:06.000Z"));
  });

  it("returns copies, so callers cannot change stored rows", async () => {
    const store = createMemoryStore();
    const video = await store.createVideo({ title: "Title", script: "Script" });
    video.title = "Changed";
    video.createdAt.setTime(0);
    const stored = await store.getVideo(video.id);
    expect(stored?.title).toBe("Title");
    expect(stored?.createdAt.getTime()).not.toBe(0);
  });

  it("keeps separate state per instance", async () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    await a.createVideo({ title: "Only in a", script: "" });
    expect(await a.listVideos()).toHaveLength(1);
    expect(await b.listVideos()).toHaveLength(0);
  });

  it("treats a lease as live until it has passed", async () => {
    const clock = createManualClock(new Date("2026-09-01T00:00:00.000Z"));
    const store = createMemoryStore({ clock });
    await store.insertInboxMessages(["m1"]);
    await store.claimInboxMessage("m1");
    clock.advance(LEASE_SECONDS * 1000);
    expect(await store.claimInboxMessage("m1")).toBeNull();
    clock.advance(1);
    expect(await store.claimInboxMessage("m1")).toMatchObject({ attempts: 2 });
  });
});
