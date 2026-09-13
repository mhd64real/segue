import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeleteVideoCard from "@/components/videos/DeleteVideoCard";
import { createMemoryStore, type MemoryStore } from "@/lib/store/memory";
import type { Video } from "@/lib/store/types";

const mocks = vi.hoisted(() => ({ ownerStore: vi.fn() }));

vi.mock("@/lib/owner", () => ({ ownerStore: mocks.ownerStore }));
vi.mock("@/app/(dashboard)/videos/actions", () => ({
  deleteVideo: vi.fn(),
  setVideoMonitoring: vi.fn(),
  updateVideo: vi.fn(),
}));

const { default: VideoPage } = await import("./page");

let store: MemoryStore;

beforeEach(() => {
  vi.clearAllMocks();
  store = createMemoryStore();
  mocks.ownerStore.mockResolvedValue({ email: "owner@example.com", store, demo: false });
});

function propsOfType(node: unknown, type: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => propsOfType(child, type));
  }
  if (!isValidElement(node)) {
    return [];
  }
  const props = node.props as Record<string, unknown>;
  const own = node.type === type ? [props] : [];
  return [...own, ...Object.values(props).flatMap((value) => propsOfType(value, type))];
}

async function deleteCardProps(videoId: string) {
  const page = await VideoPage({ params: Promise.resolve({ videoId }), searchParams: Promise.resolve({}) });
  const cards = propsOfType(page, DeleteVideoCard);
  expect(cards).toHaveLength(1);
  return cards[0];
}

async function readyDraftOn(video: Video) {
  const { sponsorship } = await store.insertSponsorship({
    gmailMessageId: `msg-${video.id}`,
    threadId: `thread-${video.id}`,
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
  });
  await store.claimSponsorship(sponsorship.id, ["matching"]);
  expect((await store.completeMatch(sponsorship.id, { videoId: video.id, fitReason: "Fits" })).status).toBe("ok");
  const inserted = await store.insertBranch({
    videoId: video.id,
    sponsorshipId: sponsorship.id,
    baseScript: video.script,
    script: `${video.script} Sponsored.`,
    segmentSummary: "Adds a read",
  });
  if (inserted.status !== "created") {
    throw new Error("branch insert failed");
  }
  const decided = await store.decideBranch(inserted.branch.id, "approved");
  if (decided.status !== "ok") {
    throw new Error("decide failed");
  }
  const draft = await store.completeDraftGeneration(decided.draft.id, decided.draft.requestId, {
    toEmail: "ada@brand.example",
    cc: [],
    subject: "Re: Sponsorship",
    body: "Yes",
  });
  return draft!;
}

describe("video page", () => {
  it("offers Delete for a video without branches or with a reply not yet sending", async () => {
    const empty = await store.createVideo({ title: "Empty", script: "Script" });
    const drafted = await store.createVideo({ title: "Drafted", script: "Script" });
    await readyDraftOn(drafted);
    const read = vi.spyOn(store, "hasSendingOrSentReply");

    expect(await deleteCardProps(empty.id)).toEqual({ videoId: empty.id, blocked: false });
    expect(await deleteCardProps(drafted.id)).toEqual({ videoId: drafted.id, blocked: false });
    expect(read.mock.calls).toEqual([[empty.id], [drafted.id]]);
  });

  it("blocks Delete while a reply for one of the video's branches is sending or sent", async () => {
    const video = await store.createVideo({ title: "Video", script: "Script" });
    const draft = await readyDraftOn(video);

    expect(await store.claimDraftSend(draft.id)).not.toBeNull();
    expect(await deleteCardProps(video.id)).toEqual({ videoId: video.id, blocked: true });
    await store.markDraftSent(draft.id, { gmailMessageId: "gmail-1", sentAt: new Date("2026-09-02T00:00:00.000Z") });
    expect(await deleteCardProps(video.id)).toEqual({ videoId: video.id, blocked: true });
  });
});
