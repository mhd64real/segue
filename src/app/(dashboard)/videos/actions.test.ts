import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "@/lib/store/memory";
import {
  StoreError,
  VIDEO_DELETED_REASON,
  VIDEO_SCRIPT_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
  type NewSponsorship,
  type Video,
} from "@/lib/store/types";
import { VIDEO_FIELD_MESSAGES } from "@/lib/videos/form";

const mocks = vi.hoisted(() => ({
  ownerStoreForAction: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/owner", () => ({ ownerStoreForAction: mocks.ownerStoreForAction }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const { createVideo, deleteVideo, setVideoMonitoring, updateVideo } = await import("./actions");

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const UNAUTHORIZED = { ok: false, error: "unauthorized" };

let store: MemoryStore;

function signedIn() {
  mocks.ownerStoreForAction.mockResolvedValue({ ok: true, email: "owner@example.com", store, demo: false });
}

function signedOut() {
  mocks.ownerStoreForAction.mockResolvedValue(UNAUTHORIZED);
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected a redirect, got ${JSON.stringify(value)}`);
    },
    (reason: unknown) => reason,
  );
  if (!isRedirectError(error)) {
    throw error;
  }
  return getURLFromRedirectError(error);
}

function revalidated(): string[] {
  return mocks.revalidatePath.mock.calls.map(([path]) => path as string).sort();
}

let counter = 0;

function sponsorshipInput(): NewSponsorship {
  counter += 1;
  return {
    gmailMessageId: `msg-${counter}`,
    threadId: `thread-${counter}`,
    fromName: "Ada",
    fromEmail: "ada@brand.example",
    replyTo: null,
    cc: [],
    subject: "Sponsorship",
    bodyText: "Offer",
    receivedAt: new Date("2026-09-01T00:00:00.000Z"),
    brand: "Brand",
    product: null,
    deliverable: null,
    compensation: null,
    deadline: null,
    summary: null,
  };
}

async function writingSponsorship(video: Video) {
  const { sponsorship } = await store.insertSponsorship(sponsorshipInput());
  await store.claimSponsorship(sponsorship.id, ["matching"]);
  const match = await store.completeMatch(sponsorship.id, { videoId: video.id, fitReason: "Fits" });
  expect(match.status).toBe("ok");
  return sponsorship;
}

async function branchedSponsorship(video: Video) {
  const sponsorship = await writingSponsorship(video);
  await store.claimSponsorship(sponsorship.id, ["writing"]);
  const inserted = await store.insertBranch({
    videoId: video.id,
    sponsorshipId: sponsorship.id,
    baseScript: video.script,
    script: `${video.script} Sponsored.`,
    segmentSummary: "Adds a read",
  });
  expect(inserted.status).toBe("created");
  await store.markBranched(sponsorship.id);
  return { sponsorship, branch: (inserted as { branch: { id: string } }).branch };
}

async function sentReply(branchId: string, send: "sending" | "sent") {
  const decided = await store.decideBranch(branchId, "approved");
  if (decided.status !== "ok") {
    throw new Error("decide failed");
  }
  const draft = await store.completeDraftGeneration(decided.draft.id, decided.draft.requestId, {
    toEmail: "ada@brand.example",
    cc: [],
    subject: "Re: Sponsorship",
    body: "Yes",
  });
  await store.claimDraftSend(draft!.id);
  if (send === "sent") {
    await store.markDraftSent(draft!.id, { gmailMessageId: "gmail-1", sentAt: new Date() });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  store = createMemoryStore();
  signedIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createVideo", () => {
  it("creates the video with a trimmed title, revalidates the list and redirects to it", async () => {
    const target = await redirectTarget(createVideo(null, form({ title: "  New video  ", script: "Line one\r\nLine two" })));
    const [video] = await store.listVideos();
    expect(target).toBe(`/videos/${video.id}`);
    expect(await store.getVideo(video.id)).toMatchObject({
      title: "New video",
      script: "Line one\nLine two",
      monitoring: false,
    });
    expect(revalidated()).toEqual(["/videos"]);
  });

  it("returns field errors for an empty, whitespace only or too long title", async () => {
    for (const [title, message] of [
      ["", VIDEO_FIELD_MESSAGES.titleRequired],
      ["    ", VIDEO_FIELD_MESSAGES.titleRequired],
      ["t".repeat(VIDEO_TITLE_MAX_LENGTH + 1), VIDEO_FIELD_MESSAGES.titleTooLong],
    ]) {
      expect(await createVideo(null, form({ title, script: "Script" }))).toEqual({
        ok: false,
        error: "invalid_input",
        fieldErrors: { title: message },
      });
    }
    expect(await store.listVideos()).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a field error for a script over the limit", async () => {
    expect(await createVideo(null, form({ title: "Title", script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) }))).toEqual({
      ok: false,
      error: "invalid_input",
      fieldErrors: { script: VIDEO_FIELD_MESSAGES.scriptTooLong },
    });
    expect(await store.listVideos()).toEqual([]);
  });

  it("accepts the longest title and script", async () => {
    await redirectTarget(
      createVideo(null, form({ title: "t".repeat(VIDEO_TITLE_MAX_LENGTH), script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH) })),
    );
    expect(await store.listVideos()).toHaveLength(1);
  });

  it("rejects input that is not form data", async () => {
    const result = await createVideo(null, { title: "Title", script: "" } as unknown as FormData);
    expect(result).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await store.listVideos()).toEqual([]);
  });

  it("does not echo the input back", async () => {
    const title = "private title text ".repeat(20);
    expect(JSON.stringify(await createVideo(null, form({ title, script: "" })))).not.toContain("private");
  });

  it("returns failed when the store fails", async () => {
    vi.spyOn(store, "createVideo").mockRejectedValueOnce(new StoreError("database", "Database error in createVideo"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await createVideo(null, form({ title: "Title", script: "" }))).toEqual({ ok: false, error: "failed" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns unauthorized before reading the input", async () => {
    signedOut();
    const data = form({ title: "Title", script: "" });
    const get = vi.spyOn(data, "get");
    expect(await createVideo(null, data)).toEqual(UNAUTHORIZED);
    expect(get).not.toHaveBeenCalled();
    expect(await store.listVideos()).toEqual([]);
  });
});

describe("updateVideo", () => {
  it("saves title and script, revalidates the list and the video, and returns the saved values", async () => {
    const video = await store.createVideo({ title: "Old", script: "Old script" });
    const result = await updateVideo(null, form({ videoId: video.id, title: " New title ", script: "New\r\nscript" }));
    expect(result).toEqual({ ok: true, video: { id: video.id, title: "New title", script: "New\nscript" } });
    expect(await store.getVideo(video.id)).toMatchObject({ title: "New title", script: "New\nscript" });
    expect(revalidated()).toEqual(["/videos", `/videos/${video.id}`]);
  });

  it("returns field errors and leaves the video unchanged", async () => {
    const video = await store.createVideo({ title: "Old", script: "Old script" });
    expect(await updateVideo(null, form({ videoId: video.id, title: " ", script: "x" }))).toEqual({
      ok: false,
      error: "invalid_input",
      fieldErrors: { title: VIDEO_FIELD_MESSAGES.titleRequired },
    });
    expect(
      await updateVideo(null, form({ videoId: video.id, title: "Ok", script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) })),
    ).toEqual({ ok: false, error: "invalid_input", fieldErrors: { script: VIDEO_FIELD_MESSAGES.scriptTooLong } });
    expect(await store.getVideo(video.id)).toEqual(video);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown, malformed or missing id", async () => {
    const updateSpy = vi.spyOn(store, "updateVideo");
    expect(await updateVideo(null, form({ videoId: UNKNOWN_ID, title: "Title", script: "" }))).toEqual({
      ok: false,
      error: "not_found",
    });
    updateSpy.mockClear();
    const cases: Record<string, string>[] = [{ videoId: "abc", title: "Title", script: "" }, { title: "Title", script: "" }];
    for (const fields of cases) {
      expect(await updateVideo(null, form(fields))).toEqual({ ok: false, error: "not_found" });
    }
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns unauthorized without touching the video", async () => {
    const video = await store.createVideo({ title: "Old", script: "" });
    signedOut();
    expect(await updateVideo(null, form({ videoId: video.id, title: "New", script: "" }))).toEqual(UNAUTHORIZED);
    expect((await store.getVideo(video.id))?.title).toBe("Old");
  });

  it("returns failed when the store fails", async () => {
    const video = await store.createVideo({ title: "Old", script: "" });
    vi.spyOn(store, "updateVideo").mockRejectedValueOnce(new StoreError("database", "Database error in updateVideo"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await updateVideo(null, form({ videoId: video.id, title: "New", script: "" }))).toEqual({
      ok: false,
      error: "failed",
    });
  });
});

describe("setVideoMonitoring", () => {
  it("turns monitoring on and off and revalidates", async () => {
    const video = await store.createVideo({ title: "Video", script: "" });
    expect(await setVideoMonitoring(null, { videoId: video.id, monitoring: true })).toEqual({ ok: true, monitoring: true });
    expect((await store.getVideo(video.id))?.monitoring).toBe(true);
    expect(revalidated()).toEqual(["/videos", `/videos/${video.id}`]);
    expect(await setVideoMonitoring(null, { videoId: video.id, monitoring: false })).toEqual({ ok: true, monitoring: false });
    expect(await store.countMonitoredVideos()).toBe(0);
  });

  it("saves only the flag", async () => {
    const video = await store.createVideo({ title: "Video", script: "Script" });
    await setVideoMonitoring(null, { videoId: video.id, monitoring: true });
    expect(await store.getVideo(video.id)).toMatchObject({ title: "Video", script: "Script", monitoring: true });
  });

  it("returns not found or invalid input", async () => {
    const video = await store.createVideo({ title: "Video", script: "" });
    expect(await setVideoMonitoring(null, { videoId: UNKNOWN_ID, monitoring: true })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await setVideoMonitoring(null, { videoId: "nope", monitoring: true })).toEqual({ ok: false, error: "not_found" });
    expect(
      await setVideoMonitoring(null, { videoId: video.id, monitoring: "true" } as unknown as { videoId: string; monitoring: boolean }),
    ).toEqual({ ok: false, error: "invalid_input" });
    expect((await store.getVideo(video.id))?.monitoring).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns unauthorized without touching the video", async () => {
    const video = await store.createVideo({ title: "Video", script: "" });
    signedOut();
    expect(await setVideoMonitoring(null, { videoId: video.id, monitoring: true })).toEqual(UNAUTHORIZED);
    expect(await store.countMonitoredVideos()).toBe(0);
  });
});

describe("deleteVideo", () => {
  it("marks writing and branched sponsorships no fit, deletes the video and redirects to the list", async () => {
    const video = await store.createVideo({ title: "Video", script: "Script" });
    const other = await store.createVideo({ title: "Other", script: "Other script" });
    const { sponsorship: branched, branch } = await branchedSponsorship(video);
    const writing = await writingSponsorship(video);
    const failed = await writingSponsorship(video);
    await store.claimSponsorship(failed.id, ["writing"]);
    expect(await store.failSponsorship(failed.id, { from: "writing", error: "Quote mismatch" })).not.toBeNull();
    const { sponsorship: otherBranched } = await branchedSponsorship(other);
    const matching = (await store.insertSponsorship(sponsorshipInput())).sponsorship;

    expect(await redirectTarget(deleteVideo(null, video.id))).toBe("/videos");

    expect(await store.getVideo(video.id)).toBeNull();
    expect(await store.getBranch(branch.id)).toBeNull();
    for (const id of [branched.id, writing.id]) {
      expect(await store.getSponsorship(id)).toMatchObject({ status: "no_fit", fitReason: VIDEO_DELETED_REASON, videoId: null });
    }
    // The confirm dialog promises No fit only for these two; a failed one stays Failed.
    expect(await store.getSponsorship(failed.id)).toMatchObject({ status: "failed", videoId: null });
    expect(await store.getSponsorship(otherBranched.id)).toMatchObject({ status: "branched", videoId: other.id });
    expect(await store.getSponsorship(matching.id)).toMatchObject({ status: "matching" });
    expect(revalidated()).toEqual(["/emails", "/sponsorships", "/videos", `/videos/${video.id}`]);
  });

  it("is blocked with reply_sent once a reply for one of its branches was sent or is sending", async () => {
    for (const send of ["sent", "sending"] as const) {
      mocks.revalidatePath.mockClear();
      const video = await store.createVideo({ title: `Video ${send}`, script: "Script" });
      const { sponsorship, branch } = await branchedSponsorship(video);
      await sentReply(branch.id, send);

      expect(await deleteVideo(null, video.id)).toEqual({ ok: false, error: "reply_sent" });
      expect(await store.getVideo(video.id)).not.toBeNull();
      expect(await store.getBranch(branch.id)).not.toBeNull();
      expect(await store.getSponsorship(sponsorship.id)).toMatchObject({ status: "branched", videoId: video.id });
      // Only the video page renders again, to show the blocked Delete button.
      expect(revalidated()).toEqual([`/videos/${video.id}`]);
    }
  });

  it("returns not found for an unknown or malformed id", async () => {
    const deleteSpy = vi.spyOn(store, "deleteVideo");
    expect(await deleteVideo(null, UNKNOWN_ID)).toEqual({ ok: false, error: "not_found" });
    deleteSpy.mockClear();
    expect(await deleteVideo(null, "../videos")).toEqual({ ok: false, error: "not_found" });
    expect(await deleteVideo(null, undefined as unknown as string)).toEqual({ ok: false, error: "not_found" });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("returns unauthorized without deleting", async () => {
    const video = await store.createVideo({ title: "Video", script: "" });
    signedOut();
    expect(await deleteVideo(null, video.id)).toEqual(UNAUTHORIZED);
    expect(await store.getVideo(video.id)).not.toBeNull();
  });

  it("returns failed when the store fails and rethrows anything unexpected", async () => {
    const video = await store.createVideo({ title: "Video", script: "" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deleteSpy = vi.spyOn(store, "deleteVideo");
    deleteSpy.mockRejectedValueOnce(new StoreError("database", "Database error in deleteVideo"));
    expect(await deleteVideo(null, video.id)).toEqual({ ok: false, error: "failed" });
    deleteSpy.mockRejectedValueOnce(new TypeError("bug"));
    await expect(deleteVideo(null, video.id)).rejects.toThrow("bug");
  });
});
