import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEASE_EXPIRED_ERROR,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  StoreError,
  VIDEO_DELETED_REASON,
  VIDEO_SCRIPT_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
  draftKindForDecision,
  type Branch,
  type BranchDecision,
  type BranchStatus,
  type EmailDraft,
  type NewSponsorship,
  type Notification,
  type Sponsorship,
  type Store,
  type Video,
} from "@/lib/store/types";

// One behavior suite for every Store implementation. It runs against the memory store
// in `pnpm test` and against the real Supabase project in `pnpm test:supabase`.

export interface StoreHarness {
  store: Store;
  // Unique per run. Every Gmail id, thread id and video title starts with it so a
  // harness can find and delete its rows.
  tag: string;
  // Current time as the store sees it (approximate for a remote database).
  now(): Date;
  // Makes every live lease look expired.
  expireLeases(): Promise<void>;
  // Bypasses the Store rules to reach a state the API never produces.
  setBranchStatus(branchId: string, status: BranchStatus): Promise<void>;
  cleanup(): Promise<void>;
}

export interface StoreContractOptions {
  skip?: boolean;
  timeoutMs?: number;
  clockToleranceMs?: number;
}

const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

async function expectStoreError(promise: Promise<unknown>, code: StoreError["code"] = "invalid_input") {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StoreError);
  expect((error as StoreError).code).toBe(code);
}

export function describeStoreContract(
  name: string,
  makeHarness: () => Promise<StoreHarness>,
  options: StoreContractOptions = {},
): void {
  const tolerance = options.clockToleranceMs ?? 0;

  describe.skipIf(options.skip ?? false)(`Store contract: ${name}`, { timeout: options.timeoutMs }, () => {
    let h: StoreHarness;
    let store: Store;
    let counter = 0;

    beforeEach(async () => {
      h = await makeHarness();
      store = h.store;
    });

    afterEach(async () => {
      await h?.cleanup();
    });

    const uid = (label: string) => `${h.tag}${label}-${(counter += 1)}`;

    const expectNear = (actual: Date | null, expected: Date) => {
      expect(actual).toBeInstanceOf(Date);
      expect(Math.abs((actual as Date).getTime() - expected.getTime())).toBeLessThanOrEqual(tolerance + 5000);
    };

    const newVideo = (overrides: Partial<{ title: string; script: string; monitoring: boolean }> = {}) =>
      store.createVideo({
        title: overrides.title ?? uid("Video"),
        script: overrides.script ?? "Intro. Main part. Outro.",
        monitoring: overrides.monitoring,
      });

    const sponsorshipInput = (overrides: Partial<NewSponsorship> = {}): NewSponsorship => ({
      gmailMessageId: uid("msg"),
      threadId: uid("thread"),
      fromName: "Ada Brand",
      fromEmail: "ada@brand.example",
      replyTo: null,
      cc: ["team@brand.example"],
      subject: "Sponsorship for your channel",
      bodyText: "We would like to sponsor a video.",
      receivedAt: new Date("2026-09-01T10:00:00.000Z"),
      brand: "Brand",
      product: "Product",
      deliverable: "60 second read",
      compensation: "1000 USD",
      deadline: null,
      summary: "Paid read",
      ...overrides,
    });

    const newSponsorship = async (overrides: Partial<NewSponsorship> = {}) => {
      const result = await store.insertSponsorship(sponsorshipInput(overrides));
      expect(result.created).toBe(true);
      return result.sponsorship;
    };

    const writingSponsorship = async (video: Video, overrides: Partial<NewSponsorship> = {}) => {
      const sponsorship = await newSponsorship(overrides);
      expect(await store.claimSponsorship(sponsorship.id, ["matching"])).not.toBeNull();
      const result = await store.completeMatch(sponsorship.id, { videoId: video.id, fitReason: "Fits the topic" });
      expect(result.status).toBe("ok");
      return (result as { sponsorship: Sponsorship }).sponsorship;
    };

    const branchFixture = async (overrides: Partial<NewSponsorship> = {}) => {
      const video = await newVideo();
      const sponsorship = await writingSponsorship(video, overrides);
      const inserted = await store.insertBranch({
        videoId: video.id,
        sponsorshipId: sponsorship.id,
        baseScript: video.script,
        script: `${video.script} Sponsored segment.`,
        segmentSummary: "Adds a sponsor read after the intro",
      });
      expect(inserted.status).toBe("created");
      const branch = (inserted as { branch: Branch }).branch;
      expect(await store.claimSponsorship(sponsorship.id, ["writing"])).not.toBeNull();
      expect(await store.markBranched(sponsorship.id)).not.toBeNull();
      return { video, sponsorship, branch };
    };

    const readyDraft = async (branch: Branch, decision: BranchDecision = "approved") => {
      const decided = await store.decideBranch(branch.id, decision);
      expect(decided.status).toBe("ok");
      const generating = (decided as { draft: EmailDraft }).draft;
      const draft = await store.completeDraftGeneration(generating.id, generating.requestId, {
        toEmail: "ada@brand.example",
        cc: ["team@brand.example"],
        subject: "Re: Sponsorship for your channel",
        body: "Thanks, happy to do it.",
      });
      expect(draft?.status).toBe("draft");
      return draft as EmailDraft;
    };

    describe("app state", () => {
      it("starts empty and patches only the given fields", async () => {
        const initial = await store.getAppState();
        expect(initial).toMatchObject({
          googleEmail: null,
          refreshTokenEnc: null,
          historyId: null,
          watchExpiresAt: null,
          lastCheckedAt: null,
          lastError: null,
          needsReauth: false,
          llmPausedReason: null,
        });
        expect(initial.updatedAt).toBeInstanceOf(Date);

        const expires = new Date("2026-09-20T06:00:00.000Z");
        const checked = new Date("2026-09-13T06:00:00.000Z");
        const patched = await store.updateAppState({
          googleEmail: "owner@example.com",
          refreshTokenEnc: "v1.a.b.c",
          watchExpiresAt: expires,
          lastCheckedAt: checked,
          needsReauth: true,
        });
        expect(patched).toMatchObject({
          googleEmail: "owner@example.com",
          refreshTokenEnc: "v1.a.b.c",
          watchExpiresAt: expires,
          lastCheckedAt: checked,
          needsReauth: true,
          lastError: null,
          llmPausedReason: null,
        });

        const second = await store.updateAppState({ needsReauth: false, lastError: "Gmail sync failed", watchExpiresAt: null });
        expect(second).toMatchObject({
          googleEmail: "owner@example.com",
          needsReauth: false,
          lastError: "Gmail sync failed",
          watchExpiresAt: null,
          lastCheckedAt: checked,
        });
        expect(await store.getAppState()).toEqual(second);
        expect(await store.updateAppState({})).toEqual(second);
      });

      it("clamps long error text", async () => {
        const state = await store.updateAppState({ lastError: "x".repeat(900), llmPausedReason: "y".repeat(700) });
        expect(state.lastError).toHaveLength(500);
        expect(state.llmPausedReason).toHaveLength(500);
      });

      it("moves history_id forward only, comparing numbers", async () => {
        expect(await store.advanceHistoryId("9")).toBe(true);
        expect((await store.getAppState()).historyId).toBe("9");
        expect(await store.advanceHistoryId("10")).toBe(true);
        expect(await store.advanceHistoryId("9")).toBe(false);
        expect(await store.advanceHistoryId("10")).toBe(false);
        expect((await store.getAppState()).historyId).toBe("10");
        expect(await store.advanceHistoryId("18446744073709551615")).toBe(true);
        expect(await store.advanceHistoryId("18446744073709551614")).toBe(false);
        expect((await store.getAppState()).historyId).toBe("18446744073709551615");
        await expectStoreError(store.advanceHistoryId("12a"));
        await expectStoreError(store.advanceHistoryId(""));
      });

      it("sets history_id unconditionally with setHistoryId", async () => {
        await store.advanceHistoryId("500");
        expect((await store.setHistoryId("100")).historyId).toBe("100");
        expect((await store.setHistoryId(null)).historyId).toBeNull();
        expect(await store.advanceHistoryId("1")).toBe(true);
        await expectStoreError(store.setHistoryId("-5"));
      });
    });

    describe("videos", () => {
      it("creates, reads and updates videos", async () => {
        const video = await newVideo({ script: "Hello" });
        expect(video).toMatchObject({ script: "Hello", monitoring: false });
        expect(video.createdAt).toBeInstanceOf(Date);
        expect(await store.getVideo(video.id)).toEqual(video);

        const updated = await store.updateVideo(video.id, { script: "Hello again", monitoring: true });
        expect(updated).toMatchObject({ id: video.id, title: video.title, script: "Hello again", monitoring: true });
        expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(video.updatedAt.getTime());
        expect(await store.updateVideo(video.id, {})).toEqual(updated);

        expect(await store.getVideo(UNKNOWN_UUID)).toBeNull();
        expect(await store.getVideo("not-a-uuid")).toBeNull();
        expect(await store.updateVideo(UNKNOWN_UUID, { title: uid("Other") })).toBeNull();
      });

      it("validates title and script length", async () => {
        await expectStoreError(newVideo({ title: "   " }));
        await expectStoreError(newVideo({ title: `${h.tag}${"t".repeat(VIDEO_TITLE_MAX_LENGTH)}` }));
        await expectStoreError(newVideo({ script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) }));
        const longest = await newVideo({ script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH) });
        expect(longest.script).toHaveLength(VIDEO_SCRIPT_MAX_LENGTH);
        await expectStoreError(store.updateVideo(longest.id, { script: "s".repeat(VIDEO_SCRIPT_MAX_LENGTH + 1) }));
        await expectStoreError(store.updateVideo(longest.id, { title: "" }));
      });

      it("lists videos newest first with branch counts, and monitored videos", async () => {
        const first = await newVideo({ monitoring: true });
        const second = await newVideo();
        const third = await newVideo({ monitoring: true });
        const { video: withBranch } = await branchFixture();

        const list = await store.listVideos();
        expect(list.map((v) => v.id)).toEqual([withBranch.id, third.id, second.id, first.id]);
        expect(list[0]).toMatchObject({ title: withBranch.title, branchCount: 1, monitoring: false });
        expect(list[1]).toMatchObject({ branchCount: 0, monitoring: true });
        expect(list[1]).not.toHaveProperty("script");

        expect((await store.listMonitoredVideos()).map((v) => v.id)).toEqual([first.id, third.id]);
        expect(await store.countMonitoredVideos()).toBe(2);
        await store.updateVideo(first.id, { monitoring: false });
        expect(await store.countMonitoredVideos()).toBe(1);
      });

      it("deletes a video, cascading branches, drafts and notifications, and leaves other videos alone", async () => {
        const { video, sponsorship, branch } = await branchFixture();
        await readyDraft(branch);
        const notification = await store.insertNotification(branch.id);
        expect(notification.status).toBe("created");

        const writing = await writingSponsorship(video);
        const failed = await writingSponsorship(video);
        await store.claimSponsorship(failed.id, ["writing"]);
        await store.failSponsorship(failed.id, { from: "writing", error: "Quote mismatch" });
        const matching = await newSponsorship();

        const other = await branchFixture({ brand: "Other" });
        const otherDraft = await readyDraft(other.branch);
        const otherNotification = await store.insertNotification(other.branch.id);
        expect(otherNotification.status).toBe("created");
        const otherWriting = await writingSponsorship(other.video);
        const otherBefore = {
          video: await store.getVideo(other.video.id),
          branch: await store.getBranch(other.branch.id),
          sponsorship: await store.getSponsorship(other.sponsorship.id),
          writing: await store.getSponsorship(otherWriting.id),
        };
        expect(otherBefore.sponsorship).toMatchObject({ status: "branched", videoId: other.video.id });

        expect(await store.deleteVideo(video.id)).toBe("deleted");
        expect(await store.getVideo(video.id)).toBeNull();
        expect(await store.getBranch(branch.id)).toBeNull();
        expect(await store.getEmailDraftByBranchId(branch.id)).toBeNull();

        expect(await store.getVideo(other.video.id)).toEqual(otherBefore.video);
        expect(await store.getBranch(other.branch.id)).toEqual(otherBefore.branch);
        expect(await store.getEmailDraft(otherDraft.id)).toEqual(otherDraft);
        expect(await store.getSponsorship(other.sponsorship.id)).toEqual(otherBefore.sponsorship);
        expect(await store.getSponsorship(otherWriting.id)).toEqual(otherBefore.writing);
        expect(await store.listBranchesForVideo(other.video.id)).toHaveLength(1);
        const notifications = await store.listNotifications(50);
        expect(notifications.map((n) => n.id)).toEqual([
          (otherNotification as { notification: Notification }).notification.id,
        ]);
        expect(notifications[0]).toMatchObject({ branchId: other.branch.id, videoId: other.video.id, brand: "Other" });
        expect(await store.countUnreadNotifications()).toBe(1);

        for (const id of [sponsorship.id, writing.id]) {
          expect(await store.getSponsorship(id)).toMatchObject({
            status: "no_fit",
            fitReason: VIDEO_DELETED_REASON,
            videoId: null,
            leaseExpiresAt: null,
          });
        }
        expect(await store.getSponsorship(failed.id)).toMatchObject({ status: "failed", videoId: null });
        expect(await store.getSponsorship(matching.id)).toMatchObject({ status: "matching", videoId: null });
        expect(await store.deleteVideo(video.id)).toBe("not_found");
        expect(await store.deleteVideo("not-a-uuid")).toBe("not_found");
      });

      it("blocks deleting a video once a reply is sending or sent", async () => {
        const { video, branch, sponsorship } = await branchFixture();
        const draft = await readyDraft(branch);
        expect(await store.claimDraftSend(draft.id)).not.toBeNull();
        expect(await store.deleteVideo(video.id)).toBe("reply_sent");

        await store.markDraftSent(draft.id, { gmailMessageId: "gmail-sent-1", sentAt: new Date("2026-09-02T00:00:00.000Z") });
        expect(await store.deleteVideo(video.id)).toBe("reply_sent");
        expect(await store.getVideo(video.id)).not.toBeNull();
        expect(await store.getBranch(branch.id)).not.toBeNull();
        expect(await store.getSponsorship(sponsorship.id)).toMatchObject({ status: "branched", videoId: video.id });
      });
    });

    describe("inbox messages", () => {
      it("inserts ids idempotently as pending", async () => {
        const a = uid("msg");
        const b = uid("msg");
        expect(await store.insertInboxMessages([a, b, a])).toBe(2);
        expect(await store.insertInboxMessages([a, b])).toBe(0);
        expect(await store.insertInboxMessages([])).toBe(0);
        expect(await store.getInboxMessage(a)).toMatchObject({
          gmailMessageId: a,
          status: "pending",
          attempts: 0,
          leaseExpiresAt: null,
          error: null,
          inputTokens: 0,
          outputTokens: 0,
        });
        expect(await store.getInboxMessage(uid("unknown"))).toBeNull();
        await expectStoreError(store.insertInboxMessages([""]));
      });

      it("claims with an attempt and a lease, once per live lease, up to the attempt limit", async () => {
        const id = uid("msg");
        await store.insertInboxMessages([id]);

        const first = await store.claimInboxMessage(id);
        expect(first).toMatchObject({ gmailMessageId: id, attempts: 1, status: "pending" });
        expectNear(first!.leaseExpiresAt, new Date(h.now().getTime() + LEASE_SECONDS * 1000));
        expect(await store.claimInboxMessage(id)).toBeNull();
        expect(await store.claimNextInboxMessage()).toBeNull();

        for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
          await h.expireLeases();
          expect(await store.claimInboxMessage(id)).toMatchObject({ attempts: attempt });
        }
        await h.expireLeases();
        expect(await store.claimInboxMessage(id)).toBeNull();
        expect(await store.getInboxMessage(id)).toMatchObject({ attempts: MAX_ATTEMPTS, status: "pending" });
        expect(await store.claimInboxMessage(uid("unknown"))).toBeNull();
      });

      it("claims the oldest claimable message next", async () => {
        const [a, b, c] = [uid("msg"), uid("msg"), uid("msg")];
        await store.insertInboxMessages([a]);
        await store.insertInboxMessages([b]);
        await store.insertInboxMessages([c]);
        expect(await store.claimInboxMessage(b)).not.toBeNull();
        expect((await store.claimNextInboxMessage())?.gmailMessageId).toBe(a);
        expect((await store.claimNextInboxMessage())?.gmailMessageId).toBe(c);
        expect(await store.claimNextInboxMessage()).toBeNull();
      });

      it("releases a transient failure and fails on the last attempt", async () => {
        const id = uid("msg");
        await store.insertInboxMessages([id]);
        expect(await store.releaseInboxMessage(id, { reason: "transient", error: "Timeout" })).toBeNull();

        await store.claimInboxMessage(id);
        const released = await store.releaseInboxMessage(id, {
          reason: "transient",
          error: "Rate limited",
          usage: { inputTokens: 100, outputTokens: 5 },
        });
        expect(released).toMatchObject({
          status: "pending",
          attempts: 1,
          leaseExpiresAt: null,
          error: "Rate limited",
          inputTokens: 100,
          outputTokens: 5,
        });
        expect(await store.releaseInboxMessage(id, { reason: "transient" })).toBeNull();

        await store.claimInboxMessage(id);
        await store.releaseInboxMessage(id, { reason: "transient", error: "Rate limited", usage: { inputTokens: 50, outputTokens: 1 } });
        await store.claimInboxMessage(id);
        const failed = await store.releaseInboxMessage(id, { reason: "transient", error: "Rate limited" });
        expect(failed).toMatchObject({ status: "failed", attempts: 3, leaseExpiresAt: null, inputTokens: 150, outputTokens: 6 });
        expect(await store.claimInboxMessage(id)).toBeNull();
      });

      it("gives the attempt back on an account-level release", async () => {
        const id = uid("msg");
        await store.insertInboxMessages([id]);
        await store.claimInboxMessage(id);
        const released = await store.releaseInboxMessage(id, { reason: "account" });
        expect(released).toMatchObject({ status: "pending", attempts: 0, leaseExpiresAt: null, error: null });

        for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
          await store.claimInboxMessage(id);
          await store.releaseInboxMessage(id, { reason: "account", error: "AI paused" });
        }
        expect(await store.getInboxMessage(id)).toMatchObject({ status: "pending", attempts: 0, error: "AI paused" });
      });

      it("settles only a claimed pending message", async () => {
        const id = uid("msg");
        await store.insertInboxMessages([id]);
        expect(await store.settleInboxMessage(id, { status: "not_sponsorship" })).toBeNull();

        await store.claimInboxMessage(id);
        const settled = await store.settleInboxMessage(id, {
          status: "not_sponsorship",
          usage: { inputTokens: 900, outputTokens: 40 },
        });
        expect(settled).toMatchObject({
          status: "not_sponsorship",
          attempts: 1,
          leaseExpiresAt: null,
          error: null,
          inputTokens: 900,
          outputTokens: 40,
        });
        expect(await store.settleInboxMessage(id, { status: "sponsorship" })).toBeNull();
        expect(await store.claimInboxMessage(id)).toBeNull();

        const failing = uid("msg");
        await store.insertInboxMessages([failing]);
        await store.claimInboxMessage(failing);
        expect(await store.settleInboxMessage(failing, { status: "failed", error: "e".repeat(800) })).toMatchObject({
          status: "failed",
          error: "e".repeat(500),
        });
        await expectStoreError(
          store.settleInboxMessage(failing, { status: "pending" as unknown as "failed" }),
        );
      });
    });

    describe("leases", () => {
      it("reclaims expired leases: used-up rows fail, others become claimable, live and failed rows stay", async () => {
        const exhausted = uid("msg");
        const retryable = uid("msg");
        const live = uid("msg");
        await store.insertInboxMessages([exhausted, retryable]);
        for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
          await store.claimInboxMessage(exhausted);
          if (i < MAX_ATTEMPTS - 1) {
            await h.expireLeases();
          }
        }
        await store.claimInboxMessage(retryable);

        const video = await newVideo();
        const writing = await writingSponsorship(video);
        await store.claimSponsorship(writing.id, ["writing"]);
        const failed = await newSponsorship();
        await store.claimSponsorship(failed.id, ["matching"]);
        await store.failSponsorship(failed.id, { from: "matching", error: "Refused" });

        await h.expireLeases();
        await store.insertInboxMessages([live]);
        await store.claimInboxMessage(live);

        const result = await store.reclaimExpiredLeases();
        expect(result).toEqual({ inboxFailed: 1, inboxReleased: 1, sponsorshipsFailed: 0, sponsorshipsReleased: 1 });
        expect(await store.getInboxMessage(exhausted)).toMatchObject({
          status: "failed",
          leaseExpiresAt: null,
          error: LEASE_EXPIRED_ERROR,
        });
        expect(await store.getInboxMessage(retryable)).toMatchObject({ status: "pending", attempts: 1, leaseExpiresAt: null });
        expect((await store.getInboxMessage(live))!.leaseExpiresAt).not.toBeNull();
        expect(await store.getSponsorship(writing.id)).toMatchObject({ status: "writing", attempts: 1, leaseExpiresAt: null });
        expect(await store.getSponsorship(failed.id)).toMatchObject({ status: "failed", error: "Refused" });

        expect(await store.reclaimExpiredLeases()).toEqual({
          inboxFailed: 0,
          inboxReleased: 0,
          sponsorshipsFailed: 0,
          sponsorshipsReleased: 0,
        });
      });

      it("fails a sponsorship whose last attempt was killed", async () => {
        const sponsorship = await newSponsorship();
        for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
          expect(await store.claimSponsorship(sponsorship.id, ["matching"])).not.toBeNull();
          await h.expireLeases();
        }
        expect(await store.claimSponsorship(sponsorship.id, ["matching"])).toBeNull();
        expect(await store.reclaimExpiredLeases()).toMatchObject({ sponsorshipsFailed: 1 });
        expect(await store.getSponsorship(sponsorship.id)).toMatchObject({ status: "failed", error: LEASE_EXPIRED_ERROR });
      });
    });

    describe("sponsorships", () => {
      it("inserts idempotently per message and per thread", async () => {
        const input = sponsorshipInput();
        const first = await store.insertSponsorship(input);
        expect(first.created).toBe(true);
        expect(first.sponsorship).toMatchObject({
          ...input,
          status: "matching",
          videoId: null,
          fitReason: null,
          attempts: 0,
          leaseExpiresAt: null,
          error: null,
          inputTokens: 0,
          outputTokens: 0,
          lastReplyAt: null,
        });

        const again = await store.insertSponsorship(input);
        expect(again).toEqual({ created: false, sponsorship: first.sponsorship });

        const sameThread = await store.insertSponsorship(sponsorshipInput({ threadId: input.threadId }));
        expect(sameThread.created).toBe(false);
        expect(sameThread.sponsorship.id).toBe(first.sponsorship.id);

        expect(await store.getSponsorship(first.sponsorship.id)).toEqual(first.sponsorship);
        expect(await store.getSponsorshipByThreadId(input.threadId)).toEqual(first.sponsorship);
        expect(await store.getSponsorshipByThreadId(uid("thread"))).toBeNull();
        expect(await store.getSponsorship(UNKNOWN_UUID)).toBeNull();
        await expectStoreError(store.insertSponsorship(sponsorshipInput({ gmailMessageId: "" })));
      });

      it("records sponsor replies, moving last_reply_at forward only", async () => {
        const sponsorship = await newSponsorship();
        const later = new Date("2026-09-05T12:00:00.000Z");
        const earlier = new Date("2026-09-04T12:00:00.000Z");
        expect((await store.recordSponsorReply(sponsorship.threadId, later))?.lastReplyAt).toEqual(later);
        expect((await store.recordSponsorReply(sponsorship.threadId, earlier))?.lastReplyAt).toEqual(later);
        expect(await store.recordSponsorReply(uid("thread"), later)).toBeNull();
      });

      it("claims by status and releases like inbox messages", async () => {
        const video = await newVideo();
        const matching = await newSponsorship();
        const writing = await writingSponsorship(video);

        expect(await store.claimSponsorship(matching.id, ["writing"])).toBeNull();
        expect((await store.claimNextSponsorship(["writing"]))?.id).toBe(writing.id);
        expect(await store.claimNextSponsorship(["writing"])).toBeNull();
        expect(await store.claimNextSponsorship([])).toBeNull();
        const claimed = await store.claimNextSponsorship(["matching", "writing"]);
        expect(claimed).toMatchObject({ id: matching.id, attempts: 1 });
        expectNear(claimed!.leaseExpiresAt, new Date(h.now().getTime() + LEASE_SECONDS * 1000));

        const released = await store.releaseSponsorship(matching.id, {
          reason: "transient",
          error: "Overloaded",
          usage: { inputTokens: 10, outputTokens: 2 },
        });
        expect(released).toMatchObject({ status: "matching", attempts: 1, leaseExpiresAt: null, error: "Overloaded", inputTokens: 10 });
        expect(await store.releaseSponsorship(matching.id, { reason: "transient" })).toBeNull();

        await store.claimSponsorship(matching.id, ["matching"]);
        expect(await store.releaseSponsorship(matching.id, { reason: "account" })).toMatchObject({ attempts: 1 });

        await store.claimSponsorship(matching.id, ["matching"]);
        await store.releaseSponsorship(matching.id, { reason: "transient" });
        await store.claimSponsorship(matching.id, ["matching"]);
        expect(await store.releaseSponsorship(matching.id, { reason: "transient", error: "Overloaded" })).toMatchObject({
          status: "failed",
          attempts: 3,
        });
        expect(await store.claimSponsorship(UNKNOWN_UUID, ["matching"])).toBeNull();
        expect(await store.claimSponsorship("not-a-uuid", ["matching"])).toBeNull();
      });

      it("completes a match into writing with attempts reset", async () => {
        const video = await newVideo();
        const sponsorship = await newSponsorship();
        expect(await store.completeMatch(sponsorship.id, { videoId: video.id, fitReason: "Fits" })).toEqual({ status: "stale" });

        await store.claimSponsorship(sponsorship.id, ["matching"]);
        expect(await store.completeMatch(sponsorship.id, { videoId: UNKNOWN_UUID, fitReason: "Fits" })).toEqual({
          status: "video_missing",
        });
        expect(await store.getSponsorship(sponsorship.id)).toMatchObject({ status: "matching", attempts: 1 });

        const result = await store.completeMatch(sponsorship.id, {
          videoId: video.id,
          fitReason: "Same topic as the video",
          usage: { inputTokens: 2000, outputTokens: 30 },
        });
        expect(result.status).toBe("ok");
        expect((result as { sponsorship: Sponsorship }).sponsorship).toMatchObject({
          status: "writing",
          videoId: video.id,
          fitReason: "Same topic as the video",
          attempts: 0,
          leaseExpiresAt: null,
          error: null,
          inputTokens: 2000,
          outputTokens: 30,
        });
        expect(await store.completeMatch(sponsorship.id, { videoId: video.id, fitReason: "Fits" })).toEqual({ status: "stale" });
        expect(await store.completeMatch("not-a-uuid", { videoId: video.id, fitReason: "Fits" })).toEqual({ status: "stale" });
      });

      it("marks no fit, branched and failed only from the claimed expected status", async () => {
        const video = await newVideo();
        const noFit = await newSponsorship();
        expect(await store.markNoFit(noFit.id, { from: "matching", reason: "No video fits" })).toBeNull();
        await store.claimSponsorship(noFit.id, ["matching"]);
        expect(await store.markNoFit(noFit.id, { from: "writing", reason: "No video fits" })).toBeNull();
        expect(
          await store.markNoFit(noFit.id, { from: "matching", reason: "No video fits", usage: { inputTokens: 7, outputTokens: 1 } }),
        ).toMatchObject({ status: "no_fit", fitReason: "No video fits", videoId: null, leaseExpiresAt: null, inputTokens: 7 });

        const writing = await writingSponsorship(video);
        expect(await store.markBranched(writing.id)).toBeNull();
        await store.claimSponsorship(writing.id, ["writing"]);
        expect(await store.markBranched(writing.id, { usage: { inputTokens: 5000, outputTokens: 900 } })).toMatchObject({
          status: "branched",
          videoId: video.id,
          fitReason: "Fits the topic",
          attempts: 1,
          inputTokens: 5000,
          outputTokens: 900,
        });

        const failing = await writingSponsorship(video);
        await store.claimSponsorship(failing.id, ["writing"]);
        expect(await store.failSponsorship(failing.id, { from: "writing", error: "Refused" })).toMatchObject({
          status: "failed",
          videoId: video.id,
          error: "Refused",
          leaseExpiresAt: null,
        });
        expect(await store.failSponsorship(failing.id, { from: "writing", error: "Refused" })).toBeNull();
      });

      it("retries a failed sponsorship back to its step with attempts reset", async () => {
        const video = await newVideo();
        const writing = await writingSponsorship(video);
        await store.claimSponsorship(writing.id, ["writing"]);
        await store.failSponsorship(writing.id, { from: "writing", error: "Max tokens" });
        expect(await store.retrySponsorship(writing.id)).toMatchObject({
          status: "writing",
          videoId: video.id,
          attempts: 0,
          error: null,
          leaseExpiresAt: null,
        });
        expect(await store.retrySponsorship(writing.id)).toBeNull();

        const matching = await newSponsorship();
        await store.claimSponsorship(matching.id, ["matching"]);
        await store.failSponsorship(matching.id, { from: "matching", error: "Schema" });
        expect(await store.retrySponsorship(matching.id)).toMatchObject({ status: "matching", attempts: 0, error: null });
        expect(await store.retrySponsorship(UNKNOWN_UUID)).toBeNull();
      });

      it("matches a no fit sponsorship again", async () => {
        const sponsorship = await newSponsorship();
        expect(await store.matchSponsorshipAgain(sponsorship.id)).toBeNull();
        await store.claimSponsorship(sponsorship.id, ["matching"]);
        await store.markNoFit(sponsorship.id, { from: "matching", reason: "No video fits" });
        expect(await store.matchSponsorshipAgain(sponsorship.id)).toMatchObject({
          status: "matching",
          videoId: null,
          fitReason: null,
          attempts: 0,
          leaseExpiresAt: null,
          error: null,
        });
        expect(await store.claimSponsorship(sponsorship.id, ["matching"])).toMatchObject({ attempts: 1 });
      });

      it("lists sponsorships newest received first with video and branch", async () => {
        const older = await newSponsorship({ receivedAt: new Date("2026-08-01T00:00:00.000Z") });
        const { video, sponsorship: branched, branch } = await branchFixture({
          receivedAt: new Date("2026-08-15T00:00:00.000Z"),
        });
        const newest = await newSponsorship({ receivedAt: new Date("2026-09-01T00:00:00.000Z") });

        const list = await store.listSponsorships();
        expect(list.map((s) => s.id)).toEqual([newest.id, branched.id, older.id]);
        expect(list[1]).toMatchObject({
          id: branched.id,
          status: "branched",
          video: { id: video.id, title: video.title },
          branchId: branch.id,
          bodyText: branched.bodyText,
        });
        expect(list[0]).toMatchObject({ video: null, branchId: null });
      });
    });

    describe("branches", () => {
      it("inserts a branch once per sponsorship", async () => {
        const video = await newVideo();
        const sponsorship = await writingSponsorship(video);
        const input = {
          videoId: video.id,
          sponsorshipId: sponsorship.id,
          baseScript: video.script,
          script: "Branch script",
          segmentSummary: "Sponsor after intro",
        };
        const created = await store.insertBranch(input);
        expect(created.status).toBe("created");
        const branch = (created as { branch: Branch }).branch;
        expect(branch).toMatchObject({ ...input, status: "pending", decidedAt: null });

        const again = await store.insertBranch({ ...input, script: "Different" });
        expect(again).toEqual({ status: "existing", branch });
        expect(await store.getBranch(branch.id)).toEqual(branch);
        expect(await store.getBranchBySponsorshipId(sponsorship.id)).toEqual(branch);
        expect(await store.getBranch(UNKNOWN_UUID)).toBeNull();

        const other = await newSponsorship();
        expect(await store.insertBranch({ ...input, sponsorshipId: other.id, videoId: UNKNOWN_UUID })).toEqual({
          status: "video_missing",
        });
        expect(await store.insertBranch({ ...input, sponsorshipId: UNKNOWN_UUID })).toEqual({
          status: "sponsorship_missing",
        });
      });

      it("lists a video's branches newest first with sponsor fields", async () => {
        const video = await newVideo();
        const makeBranch = async (brand: string) => {
          const sponsorship = await writingSponsorship(video, { brand, fromName: `${brand} team` });
          const result = await store.insertBranch({
            videoId: video.id,
            sponsorshipId: sponsorship.id,
            baseScript: video.script,
            script: `${video.script} ${brand}`,
            segmentSummary: brand,
          });
          return (result as { branch: Branch }).branch;
        };
        const first = await makeBranch("Alpha");
        const second = await makeBranch("Beta");

        const list = await store.listBranchesForVideo(video.id);
        expect(list.map((b) => b.id)).toEqual([second.id, first.id]);
        expect(list[0]).toMatchObject({
          videoId: video.id,
          status: "pending",
          brand: "Beta",
          fromName: "Beta team",
          fromEmail: "ada@brand.example",
        });
        expect(list[0]).not.toHaveProperty("script");
        expect(await store.listBranchesForVideo(UNKNOWN_UUID)).toEqual([]);
      });

      it("updates a branch script, ignoring unchanged scripts, until the reply is sent", async () => {
        const { branch } = await branchFixture();
        const updated = await store.updateBranchScript(branch.id, "Edited script");
        expect(updated.status).toBe("updated");
        const edited = (updated as { branch: Branch }).branch;
        expect(edited.script).toBe("Edited script");
        expect(edited.updatedAt.getTime()).toBeGreaterThan(branch.updatedAt.getTime());

        const unchanged = await store.updateBranchScript(branch.id, "Edited script");
        expect(unchanged).toEqual({ status: "updated", branch: edited });
        expect(await store.updateBranchScript(UNKNOWN_UUID, "x")).toEqual({ status: "not_found" });

        const draft = await readyDraft(edited);
        expect((await store.updateBranchScript(branch.id, "Before send")).status).toBe("updated");
        await store.claimDraftSend(draft.id);
        expect(await store.updateBranchScript(branch.id, "During send")).toEqual({ status: "locked" });
        expect((await store.getBranch(branch.id))?.script).toBe("Before send");
      });

      it("decides a branch and resets its draft with a new request id", async () => {
        const { branch } = await branchFixture();
        const approved = await store.decideBranch(branch.id, "approved");
        expect(approved.status).toBe("ok");
        const first = (approved as { draft: EmailDraft }).draft;
        const afterApprove = (await store.getBranch(branch.id))!;
        expect(afterApprove.status).toBe("approved");
        expect(afterApprove.decidedAt).toBeInstanceOf(Date);
        expect(first).toMatchObject({
          branchId: branch.id,
          kind: "accept",
          status: "generating",
          toEmail: null,
          subject: null,
          body: null,
          cc: [],
          error: null,
          sentAt: null,
        });
        expect(first.basedOn).toEqual(afterApprove.updatedAt);

        const rejected = await store.decideBranch(branch.id, "rejected");
        const second = (rejected as { draft: EmailDraft }).draft;
        expect(second).toMatchObject({ id: first.id, kind: "decline", status: "generating" });
        expect(second.requestId).not.toBe(first.requestId);
        expect((await store.getBranch(branch.id))?.status).toBe("rejected");
        expect(await store.getEmailDraftByBranchId(branch.id)).toEqual(second);
        expect(await store.getEmailDraft(first.id)).toEqual(second);

        expect(await store.decideBranch(UNKNOWN_UUID, "approved")).toEqual({ status: "not_found" });
        await expectStoreError(store.decideBranch(branch.id, "pending" as unknown as BranchDecision));
      });

      it("keeps the decision time on a redraft and moves based_on to the edited branch", async () => {
        const { branch } = await branchFixture();
        await readyDraft(branch, "approved");
        const decided = (await store.getBranch(branch.id))!;

        const edited = await store.updateBranchScript(branch.id, "Edited after the draft");
        const editedBranch = (edited as { branch: Branch }).branch;
        const draftBefore = (await store.getEmailDraftByBranchId(branch.id))!;
        expect(editedBranch.updatedAt.getTime()).toBeGreaterThan(draftBefore.basedOn.getTime());

        const redraft = await store.decideBranch(branch.id, "approved");
        const draft = (redraft as { draft: EmailDraft }).draft;
        const after = (await store.getBranch(branch.id))!;
        expect(after.decidedAt).toEqual(decided.decidedAt);
        expect(draft.basedOn).toEqual(after.updatedAt);
        expect(draft.requestId).not.toBe(draftBefore.requestId);
      });

      it("locks the decision once the reply is sending or sent", async () => {
        const { branch } = await branchFixture();
        const draft = await readyDraft(branch, "approved");
        await store.claimDraftSend(draft.id);
        expect(await store.decideBranch(branch.id, "rejected")).toEqual({ status: "locked" });
        await store.markDraftSent(draft.id, { gmailMessageId: "gmail-1", sentAt: new Date("2026-09-03T00:00:00.000Z") });
        expect(await store.decideBranch(branch.id, "rejected")).toEqual({ status: "locked" });
        expect(await store.decideBranch(branch.id, "approved")).toEqual({ status: "locked" });
        expect((await store.getBranch(branch.id))?.status).toBe("approved");
        expect(await store.getEmailDraft(draft.id)).toMatchObject({ status: "sent", kind: "accept" });
      });
    });

    describe("email drafts", () => {
      it("writes draft content only for the current request id", async () => {
        const { branch } = await branchFixture();
        const first = ((await store.decideBranch(branch.id, "approved")) as { draft: EmailDraft }).draft;
        const second = ((await store.decideBranch(branch.id, "rejected")) as { draft: EmailDraft }).draft;
        const content = {
          toEmail: "ada@brand.example",
          cc: ["team@brand.example"],
          subject: "Re: Sponsorship for your channel",
          body: "Thank you, but no.",
        };

        expect(await store.completeDraftGeneration(first.id, first.requestId, { ...content, body: "Yes" })).toBeNull();
        expect(await store.failDraftGeneration(first.id, first.requestId, "Timeout")).toBeNull();
        const written = await store.completeDraftGeneration(second.id, second.requestId, content);
        expect(written).toMatchObject({ ...content, kind: "decline", status: "draft", error: null });
        expect(await store.completeDraftGeneration(second.id, second.requestId, content)).toBeNull();
        expect(await store.completeDraftGeneration(UNKNOWN_UUID, second.requestId, content)).toBeNull();

        const third = ((await store.decideBranch(branch.id, "rejected")) as { draft: EmailDraft }).draft;
        expect(await store.failDraftGeneration(third.id, third.requestId, "f".repeat(600))).toMatchObject({
          status: "failed",
          error: "f".repeat(500),
        });
        expect(await store.completeDraftGeneration(third.id, third.requestId, content)).toBeNull();
      });

      it("saves edits only on drafts, never the subject", async () => {
        const { branch } = await branchFixture();
        const generating = ((await store.decideBranch(branch.id, "approved")) as { draft: EmailDraft }).draft;
        const edits = { toEmail: "deals@brand.example", cc: [], body: "Edited body" };
        expect(await store.saveDraftEdits(generating.id, edits)).toBeNull();

        const draft = await readyDraft(branch, "approved");
        const saved = await store.saveDraftEdits(draft.id, edits);
        expect(saved).toMatchObject({ ...edits, subject: draft.subject, status: "draft" });

        await store.claimDraftSend(draft.id);
        expect(await store.saveDraftEdits(draft.id, { ...edits, body: "Too late" })).toBeNull();
      });

      it("claims a send once, only while the kind matches the decision", async () => {
        const { branch } = await branchFixture();
        const draft = await readyDraft(branch, "approved");

        await h.setBranchStatus(branch.id, "rejected");
        expect(await store.claimDraftSend(draft.id)).toBeNull();
        await h.setBranchStatus(branch.id, "pending");
        expect(await store.claimDraftSend(draft.id)).toBeNull();
        await h.setBranchStatus(branch.id, "approved");

        const sending = await store.claimDraftSend(draft.id);
        expect(sending).toMatchObject({ id: draft.id, status: "sending", error: null });
        expectNear(sending!.sendingStartedAt, h.now());
        expect(await store.claimDraftSend(draft.id)).toBeNull();
        expect(await store.claimDraftSend(UNKNOWN_UUID)).toBeNull();

        const generating = await branchFixture();
        const pendingDraft = ((await store.decideBranch(generating.branch.id, "approved")) as { draft: EmailDraft }).draft;
        expect(await store.claimDraftSend(pendingDraft.id)).toBeNull();
      });

      it("finishes a send or returns it to draft", async () => {
        const { branch } = await branchFixture();
        const draft = await readyDraft(branch, "approved");
        expect(await store.markDraftSent(draft.id, { gmailMessageId: "gmail-x", sentAt: new Date() })).toBeNull();
        expect(await store.releaseDraftSend(draft.id, { error: "Gmail error" })).toBeNull();

        await store.claimDraftSend(draft.id);
        expect(await store.releaseDraftSend(draft.id, { error: "Gmail error 500" })).toMatchObject({
          status: "draft",
          sendingStartedAt: null,
          error: "Gmail error 500",
        });

        await store.claimDraftSend(draft.id);
        const sentAt = new Date("2026-09-04T08:30:00.000Z");
        const sent = await store.markDraftSent(draft.id, { gmailMessageId: "gmail-sent-42", sentAt });
        expect(sent).toMatchObject({ status: "sent", gmailMessageId: "gmail-sent-42", sentAt, error: null });
        expect(sent!.sendingStartedAt).toBeInstanceOf(Date);
        expect(await store.releaseDraftSend(draft.id, { error: null })).toBeNull();
        expect(await store.markDraftSent(draft.id, { gmailMessageId: "again", sentAt })).toBeNull();
      });

      it("lists drafts and sent replies with sponsor fields", async () => {
        const one = await branchFixture({ brand: "One", subject: "Offer one" });
        const two = await branchFixture({ brand: "Two", subject: "Offer two" });
        const three = await branchFixture({ brand: "Three" });
        const four = await branchFixture({ brand: "Four" });
        const five = await branchFixture({ brand: "Five" });
        const draftOne = await readyDraft(one.branch, "approved");
        const draftTwo = ((await store.decideBranch(two.branch.id, "rejected")) as { draft: EmailDraft }).draft;
        const draftThree = await readyDraft(three.branch, "approved");
        await store.claimDraftSend(draftThree.id);
        await store.markDraftSent(draftThree.id, { gmailMessageId: "gmail-3", sentAt: new Date("2026-09-05T00:00:00.000Z") });
        const generatingFour = ((await store.decideBranch(four.branch.id, "rejected")) as { draft: EmailDraft }).draft;
        const draftFour = await store.failDraftGeneration(generatingFour.id, generatingFour.requestId, "Timeout");
        expect(draftFour?.status).toBe("failed");
        // Claimed but never finished: a stuck send stays in Drafts so Check Gmail can settle it.
        const draftFive = await store.claimDraftSend((await readyDraft(five.branch, "approved")).id);
        expect(draftFive?.status).toBe("sending");

        const drafts = await store.listEmailDrafts("drafts");
        expect(drafts.map((d) => [d.id, d.status])).toEqual([
          [draftFive!.id, "sending"],
          [draftFour!.id, "failed"],
          [draftTwo.id, "generating"],
          [draftOne.id, "draft"],
        ]);
        expect(drafts[0]).toMatchObject({ branchId: five.branch.id, brand: "Five", kind: "accept" });
        expect(drafts[1]).toMatchObject({ branchId: four.branch.id, brand: "Four", kind: "decline", error: "Timeout" });
        expect(drafts[3]).toMatchObject({
          branchId: one.branch.id,
          videoId: one.video.id,
          sponsorshipId: one.sponsorship.id,
          brand: "One",
          fromName: "Ada Brand",
          fromEmail: "ada@brand.example",
          threadSubject: "Offer one",
          status: "draft",
        });

        const sent = await store.listEmailDrafts("sent");
        expect(sent.map((d) => d.id)).toEqual([draftThree.id]);
        expect(sent[0]).toMatchObject({ brand: "Three", status: "sent", gmailMessageId: "gmail-3" });
      });
    });

    describe("notifications", () => {
      it("inserts one notification per branch and tracks unread", async () => {
        const one = await branchFixture({ brand: "One" });
        const two = await branchFixture({ brand: "Two" });
        const created = await store.insertNotification(one.branch.id);
        expect(created.status).toBe("created");
        const first = (created as { notification: Notification }).notification;
        expect(first).toMatchObject({ branchId: one.branch.id, readAt: null });
        expect(await store.insertNotification(one.branch.id)).toEqual({ status: "existing", notification: first });
        const second = ((await store.insertNotification(two.branch.id)) as { notification: Notification }).notification;
        expect(await store.insertNotification(UNKNOWN_UUID)).toEqual({ status: "branch_missing" });

        const list = await store.listNotifications(10);
        expect(list.map((n) => n.id)).toEqual([second.id, first.id]);
        expect(list[1]).toMatchObject({
          branchId: one.branch.id,
          videoId: one.video.id,
          brand: "One",
          fromName: "Ada Brand",
          fromEmail: "ada@brand.example",
          readAt: null,
        });
        expect((await store.listNotifications(1)).map((n) => n.id)).toEqual([second.id]);
        expect(await store.countUnreadNotifications()).toBe(2);

        expect(await store.markNotificationsRead([first.id, first.id, UNKNOWN_UUID, "not-a-uuid"])).toBe(1);
        expect(await store.markNotificationsRead([first.id])).toBe(0);
        expect(await store.markNotificationsRead([])).toBe(0);
        expect(await store.countUnreadNotifications()).toBe(1);
        const read = (await store.listNotifications(10)).find((n) => n.id === first.id);
        expect(read?.readAt).toBeInstanceOf(Date);
      });
    });

    // Push, Check now and the daily cron can run at the same time, so these calls start
    // together. A correct store gives the same answer however the database orders them.
    describe("overlapping calls", () => {
      const claimed = <T>(rows: (T | null)[]) => rows.filter((row): row is T => row !== null);

      it("inserts overlapping inbox ids once", async () => {
        const ids = [uid("msg"), uid("msg")];
        const counts = await Promise.all([store.insertInboxMessages(ids), store.insertInboxMessages(ids)]);
        expect(counts[0] + counts[1]).toBe(2);
        expect(await store.getInboxMessage(ids[1])).toMatchObject({ status: "pending", attempts: 0 });
      });

      it("claims an inbox message once when two claims overlap", async () => {
        const id = uid("msg");
        await store.insertInboxMessages([id]);
        const winners = claimed(await Promise.all([store.claimInboxMessage(id), store.claimInboxMessage(id)]));
        expect(winners).toHaveLength(1);
        expect(winners[0]).toMatchObject({ gmailMessageId: id, attempts: 1 });
        expect(await store.getInboxMessage(id)).toMatchObject({ attempts: 1 });
      });

      it("gives overlapping next claims different inbox messages", async () => {
        const ids = [uid("msg"), uid("msg")];
        await store.insertInboxMessages(ids);
        const winners = claimed(await Promise.all([store.claimNextInboxMessage(), store.claimNextInboxMessage()]));
        expect(winners.map((row) => row.gmailMessageId).sort()).toEqual([...ids].sort());
        expect(winners.map((row) => row.attempts)).toEqual([1, 1]);
        expect(await store.claimNextInboxMessage()).toBeNull();
      });

      it("claims a sponsorship once when two claims overlap", async () => {
        const sponsorship = await newSponsorship();
        const winners = claimed(
          await Promise.all([
            store.claimSponsorship(sponsorship.id, ["matching"]),
            store.claimSponsorship(sponsorship.id, ["matching"]),
          ]),
        );
        expect(winners).toHaveLength(1);
        expect(await store.getSponsorship(sponsorship.id)).toMatchObject({ attempts: 1 });
      });

      it("gives overlapping next claims different sponsorships", async () => {
        const first = await newSponsorship();
        const second = await newSponsorship();
        const winners = claimed(
          await Promise.all([store.claimNextSponsorship(["matching"]), store.claimNextSponsorship(["matching"])]),
        );
        expect(winners.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
        expect(await store.claimNextSponsorship(["matching"])).toBeNull();
      });

      it("creates one sponsorship when inserts for the same message or thread overlap", async () => {
        const input = sponsorshipInput();
        const sameMessage = await Promise.all([store.insertSponsorship(input), store.insertSponsorship(input)]);
        expect(sameMessage.map((result) => result.created).sort()).toEqual([false, true]);
        expect(sameMessage[1].sponsorship).toEqual(sameMessage[0].sponsorship);

        const threadId = uid("thread");
        const sameThread = await Promise.all([
          store.insertSponsorship(sponsorshipInput({ threadId })),
          store.insertSponsorship(sponsorshipInput({ threadId })),
        ]);
        expect(sameThread.map((result) => result.created).sort()).toEqual([false, true]);
        expect(sameThread[1].sponsorship).toEqual(sameThread[0].sponsorship);
        expect((await store.getSponsorshipByThreadId(threadId))?.id).toBe(sameThread[0].sponsorship.id);
        expect(await store.listSponsorships()).toHaveLength(2);
      });

      it("creates one branch when inserts for the same sponsorship overlap", async () => {
        const video = await newVideo();
        const sponsorship = await writingSponsorship(video);
        const input = {
          videoId: video.id,
          sponsorshipId: sponsorship.id,
          baseScript: video.script,
          script: "First branch script",
          segmentSummary: "Sponsor after intro",
        };
        const results = await Promise.all([
          store.insertBranch(input),
          store.insertBranch({ ...input, script: "Second branch script" }),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(["created", "existing"]);
        const branches = results.map((result) => (result as { branch: Branch }).branch);
        expect(branches[1]).toEqual(branches[0]);
        expect(await store.getBranchBySponsorshipId(sponsorship.id)).toEqual(branches[0]);
        expect(await store.listBranchesForVideo(video.id)).toHaveLength(1);
      });

      it("creates one notification when inserts for the same branch overlap", async () => {
        const { branch } = await branchFixture();
        const results = await Promise.all([store.insertNotification(branch.id), store.insertNotification(branch.id)]);
        expect(results.map((result) => result.status).sort()).toEqual(["created", "existing"]);
        const notifications = results.map((result) => (result as { notification: Notification }).notification);
        expect(notifications[1]).toEqual(notifications[0]);
        expect((await store.listNotifications(10)).map((n) => n.id)).toEqual([notifications[0].id]);
        expect(await store.countUnreadNotifications()).toBe(1);
      });

      it("claims a send once when two send claims overlap", async () => {
        const { branch } = await branchFixture();
        const draft = await readyDraft(branch);
        const winners = claimed(await Promise.all([store.claimDraftSend(draft.id), store.claimDraftSend(draft.id)]));
        expect(winners).toHaveLength(1);
        expect(winners[0]).toMatchObject({ id: draft.id, status: "sending" });
        expect(await store.getEmailDraft(draft.id)).toEqual(winners[0]);
      });

      it("keeps the decision and the draft consistent when a decision overlaps a send claim", async () => {
        for (const decision of ["rejected", "approved"] as const) {
          const { branch } = await branchFixture();
          const draft = await readyDraft(branch, "approved");
          const [decided, sending] = await Promise.all([
            store.decideBranch(branch.id, decision),
            store.claimDraftSend(draft.id),
          ]);
          const finalBranch = await store.getBranch(branch.id);
          const finalDraft = await store.getEmailDraft(draft.id);
          const outcome = {
            decided: decided.status,
            sending: sending?.status ?? null,
            branch: finalBranch?.status,
            draft: { status: finalDraft?.status, kind: finalDraft?.kind },
          };
          // Either the decision lands first and the old draft can no longer be sent, or
          // the send lands first and the decision is locked. Never a mix of the two.
          expect([
            {
              decided: "ok",
              sending: null,
              branch: decision,
              draft: { status: "generating", kind: draftKindForDecision(decision) },
            },
            { decided: "locked", sending: "sending", branch: "approved", draft: { status: "sending", kind: "accept" } },
          ]).toContainEqual(outcome);
        }
      });
    });
  });
}
