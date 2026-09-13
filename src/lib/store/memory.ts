import { systemClock, type Clock } from "@/lib/clock";
import {
  DRAFT_VIEW_STATUSES,
  LEASE_EXPIRED_ERROR,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  StoreError,
  VIDEO_DELETED_REASON,
  draftKindForDecision,
  type AppState,
  type Branch,
  type BranchStatus,
  type EmailDraft,
  type InboxMessage,
  type Notification,
  type ReleaseInput,
  type Sponsorship,
  type SponsorshipStatus,
  type Store,
  type TokenUsage,
  type Video,
  type WorkingSponsorshipStatus,
} from "@/lib/store/types";
import {
  assertAppStatePatch,
  assertExternalId,
  assertHistoryId,
  assertNewBranch,
  assertNewSponsorship,
  assertNewVideo,
  assertVideoPatch,
  clampError,
  normalizeUsage,
} from "@/lib/store/validation";

export interface MemoryStoreOptions {
  clock?: Clock;
  generateId?: () => string;
}

export interface MemoryStore extends Store {
  // Test hooks that bypass the Store rules, used to reach states the API never produces.
  readonly testing: {
    setBranchStatus(branchId: string, status: BranchStatus): void;
  };
}

const clone = <T>(value: T): T => structuredClone(value);

function compareIds(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newestFirst<T extends { id: string }>(time: (row: T) => Date) {
  return (a: T, b: T) => time(b).getTime() - time(a).getTime() || compareIds(a, b);
}

function oldestFirst<T extends { id: string }>(time: (row: T) => Date) {
  return (a: T, b: T) => time(a).getTime() - time(b).getTime() || compareIds(a, b);
}

// Same semantics as the Supabase store and its Postgres functions, on plain maps. Every
// method runs synchronously inside its promise, so each call is atomic. Returned rows
// are copies. Safe to keep on globalThis for demo mode.
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? (() => crypto.randomUUID());

  let appState: AppState = {
    googleEmail: null,
    refreshTokenEnc: null,
    historyId: null,
    watchExpiresAt: null,
    lastCheckedAt: null,
    lastError: null,
    needsReauth: false,
    llmPausedReason: null,
    updatedAt: clock.now(),
  };
  const videos = new Map<string, Video>();
  const inbox = new Map<string, InboxMessage>();
  const sponsorships = new Map<string, Sponsorship>();
  const branches = new Map<string, Branch>();
  const drafts = new Map<string, EmailDraft>();
  const notifications = new Map<string, Notification>();

  const leaseIsLive = (lease: Date | null, now: Date) => lease !== null && lease.getTime() >= now.getTime();
  const leaseUntil = (now: Date) => new Date(now.getTime() + LEASE_SECONDS * 1000);

  const addUsage = (row: { inputTokens: number; outputTokens: number }, usage: TokenUsage | undefined) => {
    const clean = normalizeUsage(usage);
    row.inputTokens += clean.inputTokens;
    row.outputTokens += clean.outputTokens;
  };

  const draftForBranch = (branchId: string) => {
    for (const draft of drafts.values()) {
      if (draft.branchId === branchId) {
        return draft;
      }
    }
    return undefined;
  };

  const branchForSponsorship = (sponsorshipId: string) => {
    for (const branch of branches.values()) {
      if (branch.sponsorshipId === sponsorshipId) {
        return branch;
      }
    }
    return undefined;
  };

  const sponsorshipByThread = (threadId: string) => {
    for (const sponsorship of sponsorships.values()) {
      if (sponsorship.threadId === threadId) {
        return sponsorship;
      }
    }
    return undefined;
  };

  const isReplyLocked = (branchId: string) => {
    const status = draftForBranch(branchId)?.status;
    return status === "sending" || status === "sent";
  };

  const claimInbox = (gmailMessageId: string | null) => {
    const now = clock.now();
    const candidates = [...inbox.values()]
      .filter(
        (row) =>
          row.status === "pending" &&
          !leaseIsLive(row.leaseExpiresAt, now) &&
          row.attempts < MAX_ATTEMPTS &&
          (gmailMessageId === null || row.gmailMessageId === gmailMessageId),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.gmailMessageId < b.gmailMessageId ? -1 : a.gmailMessageId > b.gmailMessageId ? 1 : 0),
      );
    const row = candidates[0];
    if (!row) {
      return null;
    }
    row.attempts += 1;
    row.leaseExpiresAt = leaseUntil(now);
    row.updatedAt = now;
    return clone(row);
  };

  const claimSponsorshipRow = (id: string | null, statuses: readonly WorkingSponsorshipStatus[]) => {
    if (statuses.length === 0) {
      return null;
    }
    const now = clock.now();
    const allowed = new Set<SponsorshipStatus>(statuses);
    const row = [...sponsorships.values()]
      .filter(
        (s) =>
          allowed.has(s.status) &&
          !leaseIsLive(s.leaseExpiresAt, now) &&
          s.attempts < MAX_ATTEMPTS &&
          (id === null || s.id === id),
      )
      .sort(oldestFirst((s) => s.createdAt))[0];
    if (!row) {
      return null;
    }
    row.attempts += 1;
    row.leaseExpiresAt = leaseUntil(now);
    row.updatedAt = now;
    return clone(row);
  };

  const release = <T extends { attempts: number; leaseExpiresAt: Date | null; error: string | null; updatedAt: Date; inputTokens: number; outputTokens: number }>(
    row: T,
    input: ReleaseInput,
    fail: (row: T) => void,
  ) => {
    const now = clock.now();
    if (input.reason === "account") {
      row.attempts = Math.max(row.attempts - 1, 0);
    } else if (row.attempts >= MAX_ATTEMPTS) {
      fail(row);
    }
    row.leaseExpiresAt = null;
    row.error = clampError(input.error);
    addUsage(row, input.usage);
    row.updatedAt = now;
  };

  const settleSponsorship = (
    id: string,
    from: WorkingSponsorshipStatus,
    to: SponsorshipStatus,
    fields: { videoId?: string; fitReason?: string | null; error?: string | null; usage?: TokenUsage },
  ) => {
    const row = sponsorships.get(id);
    if (!row || row.status !== from || row.leaseExpiresAt === null) {
      return null;
    }
    const now = clock.now();
    row.status = to;
    if (to === "writing") {
      row.videoId = fields.videoId ?? null;
      row.attempts = 0;
    } else if (to === "no_fit") {
      row.videoId = null;
    }
    if (fields.fitReason !== undefined && fields.fitReason !== null) {
      row.fitReason = fields.fitReason;
    }
    row.leaseExpiresAt = null;
    row.error = clampError(fields.error);
    addUsage(row, fields.usage);
    row.updatedAt = now;
    return clone(row);
  };

  const store: MemoryStore = {
    testing: {
      setBranchStatus(branchId, status) {
        const branch = branches.get(branchId);
        if (branch) {
          branch.status = status;
          branch.decidedAt = status === "pending" ? null : (branch.decidedAt ?? clock.now());
          branch.updatedAt = clock.now();
        }
      },
    },

    async getAppState() {
      return clone(appState);
    },

    async updateAppState(patch) {
      assertAppStatePatch(patch);
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) {
        return clone(appState);
      }
      const next = { ...appState, ...Object.fromEntries(entries) } as AppState;
      if (patch.lastError !== undefined) {
        next.lastError = clampError(patch.lastError);
      }
      if (patch.llmPausedReason !== undefined) {
        next.llmPausedReason = clampError(patch.llmPausedReason);
      }
      next.updatedAt = clock.now();
      appState = clone(next);
      return clone(appState);
    },

    async setHistoryId(historyId) {
      if (historyId !== null) {
        assertHistoryId(historyId);
      }
      appState = { ...appState, historyId, updatedAt: clock.now() };
      return clone(appState);
    },

    async advanceHistoryId(historyId) {
      assertHistoryId(historyId);
      if (appState.historyId !== null && BigInt(appState.historyId) >= BigInt(historyId)) {
        return false;
      }
      appState = { ...appState, historyId, updatedAt: clock.now() };
      return true;
    },

    async listVideos() {
      const counts = new Map<string, number>();
      for (const branch of branches.values()) {
        counts.set(branch.videoId, (counts.get(branch.videoId) ?? 0) + 1);
      }
      return [...videos.values()].sort(newestFirst((v) => v.updatedAt)).map((video) => ({
        id: video.id,
        title: video.title,
        monitoring: video.monitoring,
        branchCount: counts.get(video.id) ?? 0,
        createdAt: new Date(video.createdAt),
        updatedAt: new Date(video.updatedAt),
      }));
    },

    async listMonitoredVideos() {
      return [...videos.values()]
        .filter((video) => video.monitoring)
        .sort(oldestFirst((v) => v.createdAt))
        .map(clone);
    },

    async countMonitoredVideos() {
      return [...videos.values()].filter((video) => video.monitoring).length;
    },

    async getVideo(id) {
      const video = videos.get(id);
      return video ? clone(video) : null;
    },

    async createVideo(input) {
      assertNewVideo(input);
      const now = clock.now();
      const video: Video = {
        id: generateId(),
        title: input.title,
        script: input.script,
        monitoring: input.monitoring ?? false,
        createdAt: now,
        updatedAt: now,
      };
      videos.set(video.id, video);
      return clone(video);
    },

    async updateVideo(id, patch) {
      assertVideoPatch(patch);
      const video = videos.get(id);
      if (!video) {
        return null;
      }
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) {
        return clone(video);
      }
      Object.assign(video, Object.fromEntries(entries));
      video.updatedAt = clock.now();
      return clone(video);
    },

    async deleteVideo(id) {
      const video = videos.get(id);
      if (!video) {
        return "not_found";
      }
      const videoBranches = [...branches.values()].filter((branch) => branch.videoId === id);
      if (videoBranches.some((branch) => isReplyLocked(branch.id))) {
        return "reply_sent";
      }
      const now = clock.now();
      for (const sponsorship of sponsorships.values()) {
        if (sponsorship.videoId !== id) {
          continue;
        }
        if (sponsorship.status === "writing" || sponsorship.status === "branched") {
          sponsorship.status = "no_fit";
          sponsorship.fitReason = VIDEO_DELETED_REASON;
          sponsorship.leaseExpiresAt = null;
          sponsorship.error = null;
        }
        sponsorship.videoId = null;
        sponsorship.updatedAt = now;
      }
      const branchIds = new Set(videoBranches.map((branch) => branch.id));
      for (const [draftId, draft] of drafts) {
        if (branchIds.has(draft.branchId)) {
          drafts.delete(draftId);
        }
      }
      for (const [notificationId, notification] of notifications) {
        if (branchIds.has(notification.branchId)) {
          notifications.delete(notificationId);
        }
      }
      for (const branchId of branchIds) {
        branches.delete(branchId);
      }
      videos.delete(id);
      return "deleted";
    },

    async insertInboxMessages(gmailMessageIds) {
      for (const gmailMessageId of gmailMessageIds) {
        assertExternalId(gmailMessageId, "Gmail message id");
      }
      const now = clock.now();
      let inserted = 0;
      for (const gmailMessageId of gmailMessageIds) {
        if (inbox.has(gmailMessageId)) {
          continue;
        }
        inbox.set(gmailMessageId, {
          gmailMessageId,
          status: "pending",
          attempts: 0,
          leaseExpiresAt: null,
          error: null,
          inputTokens: 0,
          outputTokens: 0,
          createdAt: now,
          updatedAt: now,
        });
        inserted += 1;
      }
      return inserted;
    },

    async getInboxMessage(gmailMessageId) {
      const row = inbox.get(gmailMessageId);
      return row ? clone(row) : null;
    },

    async claimInboxMessage(gmailMessageId) {
      return claimInbox(gmailMessageId);
    },

    async claimNextInboxMessage() {
      return claimInbox(null);
    },

    async releaseInboxMessage(gmailMessageId, input) {
      const row = inbox.get(gmailMessageId);
      if (!row || row.status !== "pending" || row.leaseExpiresAt === null) {
        return null;
      }
      release(row, input, (r) => {
        r.status = "failed";
      });
      return clone(row);
    },

    async settleInboxMessage(gmailMessageId, input) {
      if ((input.status as string) === "pending") {
        throw new StoreError("invalid_input", "Invalid inbox status");
      }
      const row = inbox.get(gmailMessageId);
      if (!row || row.status !== "pending" || row.leaseExpiresAt === null) {
        return null;
      }
      row.status = input.status;
      row.leaseExpiresAt = null;
      row.error = clampError(input.error);
      addUsage(row, input.usage);
      row.updatedAt = clock.now();
      return clone(row);
    },

    async insertSponsorship(input) {
      assertNewSponsorship(input);
      for (const existing of sponsorships.values()) {
        if (existing.gmailMessageId === input.gmailMessageId) {
          return { created: false, sponsorship: clone(existing) };
        }
      }
      const byThread = sponsorshipByThread(input.threadId);
      if (byThread) {
        return { created: false, sponsorship: clone(byThread) };
      }
      const now = clock.now();
      const sponsorship: Sponsorship = {
        ...clone(input),
        id: generateId(),
        status: "matching",
        videoId: null,
        fitReason: null,
        attempts: 0,
        leaseExpiresAt: null,
        error: null,
        inputTokens: 0,
        outputTokens: 0,
        lastReplyAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sponsorships.set(sponsorship.id, sponsorship);
      return { created: true, sponsorship: clone(sponsorship) };
    },

    async getSponsorship(id) {
      const row = sponsorships.get(id);
      return row ? clone(row) : null;
    },

    async getSponsorshipByThreadId(threadId) {
      const row = sponsorshipByThread(threadId);
      return row ? clone(row) : null;
    },

    async listSponsorships() {
      return [...sponsorships.values()].sort(newestFirst((s) => s.receivedAt)).map((sponsorship) => {
        const video = sponsorship.videoId ? videos.get(sponsorship.videoId) : undefined;
        return {
          ...clone(sponsorship),
          video: video ? { id: video.id, title: video.title } : null,
          branchId: branchForSponsorship(sponsorship.id)?.id ?? null,
        };
      });
    },

    async recordSponsorReply(threadId, repliedAt) {
      if (!(repliedAt instanceof Date) || Number.isNaN(repliedAt.getTime())) {
        throw new StoreError("invalid_input", "Invalid reply time");
      }
      const row = sponsorshipByThread(threadId);
      if (!row) {
        return null;
      }
      if (row.lastReplyAt === null || row.lastReplyAt.getTime() < repliedAt.getTime()) {
        row.lastReplyAt = new Date(repliedAt);
      }
      row.updatedAt = clock.now();
      return clone(row);
    },

    async claimSponsorship(id, statuses) {
      return claimSponsorshipRow(id, statuses);
    },

    async claimNextSponsorship(statuses) {
      return claimSponsorshipRow(null, statuses);
    },

    async releaseSponsorship(id, input) {
      const row = sponsorships.get(id);
      if (!row || (row.status !== "matching" && row.status !== "writing") || row.leaseExpiresAt === null) {
        return null;
      }
      release(row, input, (r) => {
        r.status = "failed";
      });
      return clone(row);
    },

    async completeMatch(id, input) {
      const row = sponsorships.get(id);
      if (!row || row.status !== "matching" || row.leaseExpiresAt === null) {
        return { status: "stale" };
      }
      if (!videos.has(input.videoId)) {
        return { status: "video_missing" };
      }
      const sponsorship = settleSponsorship(id, "matching", "writing", {
        videoId: input.videoId,
        fitReason: input.fitReason,
        usage: input.usage,
      });
      return sponsorship ? { status: "ok", sponsorship } : { status: "stale" };
    },

    async markNoFit(id, input) {
      return settleSponsorship(id, input.from, "no_fit", { fitReason: input.reason, usage: input.usage });
    },

    async markBranched(id, input) {
      return settleSponsorship(id, "writing", "branched", { usage: input?.usage });
    },

    async failSponsorship(id, input) {
      return settleSponsorship(id, input.from, "failed", { error: input.error, usage: input.usage });
    },

    async retrySponsorship(id) {
      const row = sponsorships.get(id);
      if (!row || row.status !== "failed") {
        return null;
      }
      row.status = row.videoId === null ? "matching" : "writing";
      row.attempts = 0;
      row.leaseExpiresAt = null;
      row.error = null;
      row.updatedAt = clock.now();
      return clone(row);
    },

    async matchSponsorshipAgain(id) {
      const row = sponsorships.get(id);
      if (!row || row.status !== "no_fit") {
        return null;
      }
      row.status = "matching";
      row.videoId = null;
      row.fitReason = null;
      row.attempts = 0;
      row.leaseExpiresAt = null;
      row.error = null;
      row.updatedAt = clock.now();
      return clone(row);
    },

    async insertBranch(input) {
      assertNewBranch(input);
      const existing = branchForSponsorship(input.sponsorshipId);
      if (existing) {
        return { status: "existing", branch: clone(existing) };
      }
      if (!sponsorships.has(input.sponsorshipId)) {
        return { status: "sponsorship_missing" };
      }
      if (!videos.has(input.videoId)) {
        return { status: "video_missing" };
      }
      const now = clock.now();
      const branch: Branch = {
        id: generateId(),
        videoId: input.videoId,
        sponsorshipId: input.sponsorshipId,
        baseScript: input.baseScript,
        script: input.script,
        segmentSummary: input.segmentSummary,
        status: "pending",
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      branches.set(branch.id, branch);
      return { status: "created", branch: clone(branch) };
    },

    async getBranch(id) {
      const row = branches.get(id);
      return row ? clone(row) : null;
    },

    async getBranchBySponsorshipId(sponsorshipId) {
      const row = branchForSponsorship(sponsorshipId);
      return row ? clone(row) : null;
    },

    async listBranchesForVideo(videoId) {
      return [...branches.values()]
        .filter((branch) => branch.videoId === videoId)
        .sort(newestFirst((b) => b.createdAt))
        .map((branch) => {
          const sponsorship = sponsorships.get(branch.sponsorshipId)!;
          return {
            id: branch.id,
            videoId: branch.videoId,
            sponsorshipId: branch.sponsorshipId,
            status: branch.status,
            decidedAt: branch.decidedAt ? new Date(branch.decidedAt) : null,
            createdAt: new Date(branch.createdAt),
            updatedAt: new Date(branch.updatedAt),
            brand: sponsorship.brand,
            fromName: sponsorship.fromName,
            fromEmail: sponsorship.fromEmail,
          };
        });
    },

    async updateBranchScript(id, script) {
      if (typeof script !== "string") {
        throw new StoreError("invalid_input", "Invalid branch script");
      }
      const branch = branches.get(id);
      if (!branch) {
        return { status: "not_found" };
      }
      if (isReplyLocked(id)) {
        return { status: "locked" };
      }
      if (branch.script !== script) {
        branch.script = script;
        branch.updatedAt = clock.now();
      }
      return { status: "updated", branch: clone(branch) };
    },

    async decideBranch(id, decision) {
      if (decision !== "approved" && decision !== "rejected") {
        throw new StoreError("invalid_input", "Invalid branch decision");
      }
      const branch = branches.get(id);
      if (!branch) {
        return { status: "not_found" };
      }
      if (isReplyLocked(id)) {
        return { status: "locked" };
      }
      const now = clock.now();
      branch.decidedAt = branch.status === decision && branch.decidedAt ? branch.decidedAt : now;
      branch.status = decision;
      branch.updatedAt = now;

      const reset = {
        kind: draftKindForDecision(decision),
        requestId: generateId(),
        basedOn: new Date(branch.updatedAt),
        status: "generating" as const,
        toEmail: null,
        cc: [],
        subject: null,
        body: null,
        error: null,
        sendingStartedAt: null,
        gmailMessageId: null,
        sentAt: null,
        updatedAt: now,
      };
      let draft = draftForBranch(id);
      if (draft) {
        Object.assign(draft, reset);
      } else {
        draft = { id: generateId(), branchId: id, createdAt: now, ...reset };
        drafts.set(draft.id, draft);
      }
      return { status: "ok", draft: clone(draft) };
    },

    async getEmailDraft(id) {
      const row = drafts.get(id);
      return row ? clone(row) : null;
    },

    async getEmailDraftByBranchId(branchId) {
      const row = draftForBranch(branchId);
      return row ? clone(row) : null;
    },

    async listEmailDrafts(view) {
      const statuses = new Set(DRAFT_VIEW_STATUSES[view]);
      const order = view === "sent" ? newestFirst<EmailDraft>((d) => d.sentAt ?? d.updatedAt) : newestFirst<EmailDraft>((d) => d.updatedAt);
      return [...drafts.values()]
        .filter((draft) => statuses.has(draft.status))
        .sort(order)
        .map((draft) => {
          const branch = branches.get(draft.branchId)!;
          const sponsorship = sponsorships.get(branch.sponsorshipId)!;
          return {
            ...clone(draft),
            videoId: branch.videoId,
            sponsorshipId: sponsorship.id,
            brand: sponsorship.brand,
            fromName: sponsorship.fromName,
            fromEmail: sponsorship.fromEmail,
            threadSubject: sponsorship.subject,
          };
        });
    },

    async completeDraftGeneration(id, requestId, content) {
      const draft = drafts.get(id);
      if (!draft || draft.requestId !== requestId || draft.status !== "generating") {
        return null;
      }
      draft.toEmail = content.toEmail;
      draft.cc = [...content.cc];
      draft.subject = content.subject;
      draft.body = content.body;
      draft.status = "draft";
      draft.error = null;
      draft.updatedAt = clock.now();
      return clone(draft);
    },

    async failDraftGeneration(id, requestId, error) {
      const draft = drafts.get(id);
      if (!draft || draft.requestId !== requestId || draft.status !== "generating") {
        return null;
      }
      draft.status = "failed";
      draft.error = clampError(error);
      draft.updatedAt = clock.now();
      return clone(draft);
    },

    async saveDraftEdits(id, edits) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== "draft") {
        return null;
      }
      draft.toEmail = edits.toEmail;
      draft.cc = [...edits.cc];
      draft.body = edits.body;
      draft.updatedAt = clock.now();
      return clone(draft);
    },

    async claimDraftSend(id) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== "draft") {
        return null;
      }
      const branch = branches.get(draft.branchId);
      if (!branch || branch.status === "pending" || draftKindForDecision(branch.status) !== draft.kind) {
        return null;
      }
      const now = clock.now();
      draft.status = "sending";
      draft.sendingStartedAt = now;
      draft.error = null;
      draft.updatedAt = now;
      return clone(draft);
    },

    async markDraftSent(id, input) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== "sending") {
        return null;
      }
      draft.status = "sent";
      draft.gmailMessageId = input.gmailMessageId;
      draft.sentAt = new Date(input.sentAt);
      draft.error = null;
      draft.updatedAt = clock.now();
      return clone(draft);
    },

    async releaseDraftSend(id, input) {
      const draft = drafts.get(id);
      if (!draft || draft.status !== "sending") {
        return null;
      }
      draft.status = "draft";
      draft.sendingStartedAt = null;
      draft.error = clampError(input.error);
      draft.updatedAt = clock.now();
      return clone(draft);
    },

    async insertNotification(branchId) {
      for (const notification of notifications.values()) {
        if (notification.branchId === branchId) {
          return { status: "existing", notification: clone(notification) };
        }
      }
      if (!branches.has(branchId)) {
        return { status: "branch_missing" };
      }
      const notification: Notification = { id: generateId(), branchId, readAt: null, createdAt: clock.now() };
      notifications.set(notification.id, notification);
      return { status: "created", notification: clone(notification) };
    },

    async listNotifications(limit) {
      return [...notifications.values()]
        .sort(newestFirst((n) => n.createdAt))
        .slice(0, Math.max(0, Math.floor(limit)))
        .map((notification) => {
          const branch = branches.get(notification.branchId)!;
          const sponsorship = sponsorships.get(branch.sponsorshipId)!;
          return {
            ...clone(notification),
            videoId: branch.videoId,
            brand: sponsorship.brand,
            fromName: sponsorship.fromName,
            fromEmail: sponsorship.fromEmail,
          };
        });
    },

    async countUnreadNotifications() {
      return [...notifications.values()].filter((notification) => notification.readAt === null).length;
    },

    async markNotificationsRead(ids) {
      const now = clock.now();
      let changed = 0;
      for (const id of new Set(ids)) {
        const notification = notifications.get(id);
        if (notification && notification.readAt === null) {
          notification.readAt = now;
          changed += 1;
        }
      }
      return changed;
    },

    async reclaimExpiredLeases() {
      const now = clock.now();
      const result = { inboxFailed: 0, inboxReleased: 0, sponsorshipsFailed: 0, sponsorshipsReleased: 0 };
      const expired = (lease: Date | null) => lease !== null && lease.getTime() < now.getTime();
      for (const row of inbox.values()) {
        if (row.status !== "pending" || !expired(row.leaseExpiresAt)) {
          continue;
        }
        if (row.attempts >= MAX_ATTEMPTS) {
          row.status = "failed";
          row.error = LEASE_EXPIRED_ERROR;
          result.inboxFailed += 1;
        } else {
          result.inboxReleased += 1;
        }
        row.leaseExpiresAt = null;
        row.updatedAt = now;
      }
      for (const row of sponsorships.values()) {
        if ((row.status !== "matching" && row.status !== "writing") || !expired(row.leaseExpiresAt)) {
          continue;
        }
        if (row.attempts >= MAX_ATTEMPTS) {
          row.status = "failed";
          row.error = LEASE_EXPIRED_ERROR;
          result.sponsorshipsFailed += 1;
        } else {
          result.sponsorshipsReleased += 1;
        }
        row.leaseExpiresAt = null;
        row.updatedAt = now;
      }
      return result;
    },
  };

  return store;
}
