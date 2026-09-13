import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/lib/store/memory";
import { changeVideoMonitoring, removeVideo } from "@/lib/videos/lifecycle";

describe("changeVideoMonitoring", () => {
  it("saves the flag in both directions", async () => {
    const store = createMemoryStore();
    const video = await store.createVideo({ title: "Video", script: "Script" });
    const on = await changeVideoMonitoring({ store }, video.id, true);
    expect(on).toMatchObject({ status: "ok", video: { id: video.id, monitoring: true, title: "Video", script: "Script" } });
    expect(await store.countMonitoredVideos()).toBe(1);
    expect(await changeVideoMonitoring({ store }, video.id, false)).toMatchObject({ video: { monitoring: false } });
    expect(await store.countMonitoredVideos()).toBe(0);
  });

  it("reports an unknown video", async () => {
    const store = createMemoryStore();
    expect(await changeVideoMonitoring({ store }, "00000000-0000-4000-8000-000000000000", true)).toEqual({
      status: "not_found",
    });
  });
});

describe("removeVideo", () => {
  it("returns the Store delete outcome", async () => {
    const store = createMemoryStore();
    const video = await store.createVideo({ title: "Video", script: "Script" });
    expect(await removeVideo({ store }, video.id)).toBe("deleted");
    expect(await removeVideo({ store }, video.id)).toBe("not_found");
  });
});
