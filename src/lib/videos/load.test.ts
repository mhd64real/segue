import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@/lib/store/memory";
import { getVideoOrNotFound } from "@/lib/videos/load";

async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected notFound()");
    },
    (reason: unknown) => reason,
  );
  expect(isHTTPAccessFallbackError(error)).toBe(true);
  expect(getAccessFallbackHTTPStatus(error as Parameters<typeof getAccessFallbackHTTPStatus>[0])).toBe(404);
}

describe("getVideoOrNotFound", () => {
  it("returns the video for a known id, in any letter case", async () => {
    const store = createMemoryStore();
    const video = await store.createVideo({ title: "Known", script: "Script" });
    expect(await getVideoOrNotFound(store, video.id)).toEqual(video);
    expect(await getVideoOrNotFound(store, video.id.toUpperCase())).toEqual(video);
  });

  it("renders not found for an unknown id", async () => {
    const store = createMemoryStore();
    await expectNotFound(getVideoOrNotFound(store, "00000000-0000-4000-8000-000000000000"));
  });

  it("renders not found for a malformed id without reading the store", async () => {
    const store = createMemoryStore();
    const getVideo = vi.spyOn(store, "getVideo");
    for (const id of ["abc", "new", "%20", "00000000-0000-4000-8000-00000000000z", ""]) {
      await expectNotFound(getVideoOrNotFound(store, id));
    }
    expect(getVideo).not.toHaveBeenCalled();
  });
});
