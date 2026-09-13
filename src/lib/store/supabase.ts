import "server-only";
import type { PostgrestError, PostgrestSingleResponse } from "@supabase/supabase-js";
import { systemClock, type Clock } from "@/lib/clock";
import {
  DRAFT_VIEW_STATUSES,
  LEASE_EXPIRED_ERROR,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  StoreError,
  type AppState,
  type AppStatePatch,
  type Branch,
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
  isUuid,
  normalizeUsage,
} from "@/lib/store/validation";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];
type AppStateRow = Tables["app_state"]["Row"];
type VideoRow = Tables["videos"]["Row"];
type InboxRow = Tables["inbox_messages"]["Row"];
type SponsorshipRow = Tables["sponsorships"]["Row"];
type BranchRow = Tables["branches"]["Row"];
type DraftRow = Tables["email_drafts"]["Row"];
type NotificationRow = Tables["notifications"]["Row"];

const toDate = (value: string) => new Date(value);
const toDateOrNull = (value: string | null) => (value === null ? null : new Date(value));
const toIso = (value: Date | null) => (value === null ? null : value.toISOString());

// PostgREST may return an embedded to-one relation as an object or a one-item array,
// depending on how it detects the relationship.
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function toAppState(row: AppStateRow): AppState {
  return {
    googleEmail: row.google_email,
    refreshTokenEnc: row.refresh_token_enc,
    historyId: row.history_id,
    watchExpiresAt: toDateOrNull(row.watch_expires_at),
    lastCheckedAt: toDateOrNull(row.last_checked_at),
    lastError: row.last_error,
    needsReauth: row.needs_reauth,
    llmPausedReason: row.llm_paused_reason,
    updatedAt: toDate(row.updated_at),
  };
}

function toVideo(row: VideoRow): Video {
  return {
    id: row.id,
    title: row.title,
    script: row.script,
    monitoring: row.monitoring,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toInboxMessage(row: InboxRow): InboxMessage {
  return {
    gmailMessageId: row.gmail_message_id,
    status: row.status,
    attempts: row.attempts,
    leaseExpiresAt: toDateOrNull(row.lease_expires_at),
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toSponsorship(row: SponsorshipRow): Sponsorship {
  return {
    id: row.id,
    gmailMessageId: row.gmail_message_id,
    threadId: row.thread_id,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    cc: row.cc,
    subject: row.subject,
    bodyText: row.body_text,
    receivedAt: toDate(row.received_at),
    brand: row.brand,
    product: row.product,
    deliverable: row.deliverable,
    compensation: row.compensation,
    deadline: row.deadline,
    summary: row.summary,
    status: row.status,
    videoId: row.video_id,
    fitReason: row.fit_reason,
    attempts: row.attempts,
    leaseExpiresAt: toDateOrNull(row.lease_expires_at),
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    lastReplyAt: toDateOrNull(row.last_reply_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    videoId: row.video_id,
    sponsorshipId: row.sponsorship_id,
    baseScript: row.base_script,
    script: row.script,
    segmentSummary: row.segment_summary,
    status: row.status,
    decidedAt: toDateOrNull(row.decided_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toDraft(row: DraftRow): EmailDraft {
  return {
    id: row.id,
    branchId: row.branch_id,
    kind: row.kind,
    requestId: row.request_id,
    basedOn: toDate(row.based_on),
    toEmail: row.to_email,
    cc: row.cc,
    subject: row.subject,
    body: row.body,
    status: row.status,
    error: row.error,
    sendingStartedAt: toDateOrNull(row.sending_started_at),
    gmailMessageId: row.gmail_message_id,
    sentAt: toDateOrNull(row.sent_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    branchId: row.branch_id,
    readAt: toDateOrNull(row.read_at),
    createdAt: toDate(row.created_at),
  };
}

const INPUT_ERROR_CODES = new Set(["22023", "22P02", "23502", "23514"]);

// Never copies PostgREST messages or details: they can quote row values.
function storeError(operation: string, error: PostgrestError): StoreError {
  const code = INPUT_ERROR_CODES.has(error.code) ? "invalid_input" : "database";
  const message = code === "invalid_input" ? `Invalid input in ${operation}` : `Database error in ${operation}`;
  return new StoreError(code, message, { cause: { code: error.code } });
}

function check<T>(operation: string, result: PostgrestSingleResponse<T>): T {
  if (result.error) {
    throw storeError(operation, result.error);
  }
  return result.data;
}

function usageArgs(usage: TokenUsage | undefined) {
  const clean = normalizeUsage(usage);
  return { p_input_tokens: clean.inputTokens, p_output_tokens: clean.outputTokens };
}

function errorArg(error: string | null | undefined) {
  const clamped = clampError(error);
  return clamped === null ? {} : { p_error: clamped };
}

const SPONSOR_FIELDS = "brand, from_name, from_email";

export interface SupabaseStoreOptions {
  // Used only for read_at; every other timestamp comes from the database.
  clock?: Clock;
}

// Store on the Supabase admin client. Atomic operations run in Postgres functions
// (see supabase/migrations); plain reads and single conditional updates use PostgREST.
export function createSupabaseStore(db: AdminClient, options: SupabaseStoreOptions = {}): Store {
  const clock = options.clock ?? systemClock;

  const ensureAppState = async () => {
    const row = check(
      "getAppState",
      await db.from("app_state").select("*").eq("id", true).maybeSingle(),
    );
    if (row) {
      return row;
    }
    return check(
      "getAppState",
      await db.from("app_state").upsert({ id: true }, { onConflict: "id" }).select("*").single(),
    );
  };

  const getSponsorshipRow = async (id: string) => {
    if (!isUuid(id)) {
      return null;
    }
    return check("getSponsorship", await db.from("sponsorships").select("*").eq("id", id).maybeSingle());
  };

  const getBranchRow = async (id: string) => {
    if (!isUuid(id)) {
      return null;
    }
    return check("getBranch", await db.from("branches").select("*").eq("id", id).maybeSingle());
  };

  const getDraftRow = async (id: string) => {
    if (!isUuid(id)) {
      return null;
    }
    return check("getEmailDraft", await db.from("email_drafts").select("*").eq("id", id).maybeSingle());
  };

  const claimSponsorshipRow = async (id: string | null, statuses: readonly WorkingSponsorshipStatus[]) => {
    if (statuses.length === 0 || (id !== null && !isUuid(id))) {
      return null;
    }
    const rows = check(
      "claimSponsorship",
      await db.rpc("claim_sponsorship", {
        p_statuses: [...statuses],
        p_lease_seconds: LEASE_SECONDS,
        p_max_attempts: MAX_ATTEMPTS,
        ...(id === null ? {} : { p_id: id }),
      }),
    );
    const row = one(rows);
    return row ? toSponsorship(row) : null;
  };

  const settleSponsorship = async (
    id: string,
    from: WorkingSponsorshipStatus,
    to: SponsorshipStatus,
    fields: { videoId?: string; fitReason?: string; error?: string | null; usage?: TokenUsage },
  ) => {
    return db.rpc("settle_sponsorship", {
      p_id: id,
      p_from: from,
      p_to: to,
      ...(fields.videoId === undefined ? {} : { p_video_id: fields.videoId }),
      ...(fields.fitReason === undefined ? {} : { p_fit_reason: fields.fitReason }),
      ...errorArg(fields.error),
      ...usageArgs(fields.usage),
    });
  };

  const settleSponsorshipOrNull = async (
    operation: string,
    id: string,
    from: WorkingSponsorshipStatus,
    to: SponsorshipStatus,
    fields: { fitReason?: string; error?: string | null; usage?: TokenUsage },
  ) => {
    if (!isUuid(id)) {
      return null;
    }
    const row = one(check(operation, await settleSponsorship(id, from, to, fields)));
    return row ? toSponsorship(row) : null;
  };

  const releaseArgs = (input: ReleaseInput) => ({
    p_refund_attempt: input.reason === "account",
    p_max_attempts: MAX_ATTEMPTS,
    ...errorArg(input.error),
    ...usageArgs(input.usage),
  });

  const store: Store = {
    async getAppState() {
      return toAppState(await ensureAppState());
    },

    async updateAppState(patch: AppStatePatch) {
      assertAppStatePatch(patch);
      const update: Tables["app_state"]["Update"] = {};
      if (patch.googleEmail !== undefined) update.google_email = patch.googleEmail;
      if (patch.refreshTokenEnc !== undefined) update.refresh_token_enc = patch.refreshTokenEnc;
      if (patch.watchExpiresAt !== undefined) update.watch_expires_at = toIso(patch.watchExpiresAt);
      if (patch.lastCheckedAt !== undefined) update.last_checked_at = toIso(patch.lastCheckedAt);
      if (patch.lastError !== undefined) update.last_error = clampError(patch.lastError);
      if (patch.needsReauth !== undefined) update.needs_reauth = patch.needsReauth;
      if (patch.llmPausedReason !== undefined) update.llm_paused_reason = clampError(patch.llmPausedReason);
      if (Object.keys(update).length === 0) {
        return store.getAppState();
      }
      const row = check(
        "updateAppState",
        await db.from("app_state").upsert({ id: true, ...update }, { onConflict: "id" }).select("*").single(),
      );
      return toAppState(row);
    },

    async setHistoryId(historyId) {
      if (historyId !== null) {
        assertHistoryId(historyId);
      }
      const row = check(
        "setHistoryId",
        await db
          .from("app_state")
          .upsert({ id: true, history_id: historyId }, { onConflict: "id" })
          .select("*")
          .single(),
      );
      return toAppState(row);
    },

    async advanceHistoryId(historyId) {
      assertHistoryId(historyId);
      return check("advanceHistoryId", await db.rpc("advance_history_id", { p_history_id: historyId }));
    },

    async listVideos() {
      const rows = check(
        "listVideos",
        await db
          .from("videos")
          .select("id, title, monitoring, created_at, updated_at, branches(count)")
          .order("updated_at", { ascending: false })
          .order("id"),
      );
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        monitoring: row.monitoring,
        branchCount: one(row.branches)?.count ?? 0,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      }));
    },

    async listMonitoredVideos() {
      const rows = check(
        "listMonitoredVideos",
        await db.from("videos").select("*").eq("monitoring", true).order("created_at").order("id"),
      );
      return rows.map(toVideo);
    },

    async countMonitoredVideos() {
      const { count, error } = await db
        .from("videos")
        .select("id", { count: "exact", head: true })
        .eq("monitoring", true);
      if (error) {
        throw storeError("countMonitoredVideos", error);
      }
      return count ?? 0;
    },

    async getVideo(id) {
      if (!isUuid(id)) {
        return null;
      }
      const row = check("getVideo", await db.from("videos").select("*").eq("id", id).maybeSingle());
      return row ? toVideo(row) : null;
    },

    async createVideo(input) {
      assertNewVideo(input);
      const row = check(
        "createVideo",
        await db
          .from("videos")
          .insert({ title: input.title, script: input.script, monitoring: input.monitoring ?? false })
          .select("*")
          .single(),
      );
      return toVideo(row);
    },

    async updateVideo(id, patch) {
      assertVideoPatch(patch);
      if (!isUuid(id)) {
        return null;
      }
      const update: Tables["videos"]["Update"] = {};
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.script !== undefined) update.script = patch.script;
      if (patch.monitoring !== undefined) update.monitoring = patch.monitoring;
      if (Object.keys(update).length === 0) {
        return store.getVideo(id);
      }
      const row = check("updateVideo", await db.from("videos").update(update).eq("id", id).select("*").maybeSingle());
      return row ? toVideo(row) : null;
    },

    async deleteVideo(id) {
      if (!isUuid(id)) {
        return "not_found";
      }
      const result = check("deleteVideo", await db.rpc("delete_video", { p_video_id: id }));
      if (result === "deleted" || result === "not_found" || result === "reply_sent") {
        return result;
      }
      throw new StoreError("database", "Database error in deleteVideo");
    },

    async insertInboxMessages(gmailMessageIds) {
      for (const gmailMessageId of gmailMessageIds) {
        assertExternalId(gmailMessageId, "Gmail message id");
      }
      const unique = [...new Set(gmailMessageIds)];
      if (unique.length === 0) {
        return 0;
      }
      const rows = check(
        "insertInboxMessages",
        await db
          .from("inbox_messages")
          .upsert(
            unique.map((gmailMessageId) => ({ gmail_message_id: gmailMessageId })),
            { onConflict: "gmail_message_id", ignoreDuplicates: true },
          )
          .select("gmail_message_id"),
      );
      return rows.length;
    },

    async getInboxMessage(gmailMessageId) {
      const row = check(
        "getInboxMessage",
        await db.from("inbox_messages").select("*").eq("gmail_message_id", gmailMessageId).maybeSingle(),
      );
      return row ? toInboxMessage(row) : null;
    },

    async claimInboxMessage(gmailMessageId) {
      const rows = check(
        "claimInboxMessage",
        await db.rpc("claim_inbox_message", {
          p_gmail_message_id: gmailMessageId,
          p_lease_seconds: LEASE_SECONDS,
          p_max_attempts: MAX_ATTEMPTS,
        }),
      );
      const row = one(rows);
      return row ? toInboxMessage(row) : null;
    },

    async claimNextInboxMessage() {
      const rows = check(
        "claimNextInboxMessage",
        await db.rpc("claim_inbox_message", { p_lease_seconds: LEASE_SECONDS, p_max_attempts: MAX_ATTEMPTS }),
      );
      const row = one(rows);
      return row ? toInboxMessage(row) : null;
    },

    async releaseInboxMessage(gmailMessageId, input) {
      const rows = check(
        "releaseInboxMessage",
        await db.rpc("release_inbox_message", { p_gmail_message_id: gmailMessageId, ...releaseArgs(input) }),
      );
      const row = one(rows);
      return row ? toInboxMessage(row) : null;
    },

    async settleInboxMessage(gmailMessageId, input) {
      if ((input.status as string) === "pending") {
        throw new StoreError("invalid_input", "Invalid inbox status");
      }
      const rows = check(
        "settleInboxMessage",
        await db.rpc("settle_inbox_message", {
          p_gmail_message_id: gmailMessageId,
          p_status: input.status,
          ...errorArg(input.error),
          ...usageArgs(input.usage),
        }),
      );
      const row = one(rows);
      return row ? toInboxMessage(row) : null;
    },

    async insertSponsorship(input) {
      assertNewSponsorship(input);
      const insert: Tables["sponsorships"]["Insert"] = {
        gmail_message_id: input.gmailMessageId,
        thread_id: input.threadId,
        from_name: input.fromName,
        from_email: input.fromEmail,
        reply_to: input.replyTo,
        cc: input.cc,
        subject: input.subject,
        body_text: input.bodyText,
        received_at: input.receivedAt.toISOString(),
        brand: input.brand,
        product: input.product,
        deliverable: input.deliverable,
        compensation: input.compensation,
        deadline: input.deadline,
        summary: input.summary,
      };
      const response = await db
        .from("sponsorships")
        .upsert(insert, { onConflict: "gmail_message_id", ignoreDuplicates: true })
        .select("*");
      if (response.error && response.error.code !== "23505") {
        throw storeError("insertSponsorship", response.error);
      }
      const created = one(response.data);
      if (created) {
        return { created: true, sponsorship: toSponsorship(created) };
      }
      const byMessage = check(
        "insertSponsorship",
        await db.from("sponsorships").select("*").eq("gmail_message_id", input.gmailMessageId).maybeSingle(),
      );
      const existing =
        byMessage ??
        check(
          "insertSponsorship",
          await db.from("sponsorships").select("*").eq("thread_id", input.threadId).maybeSingle(),
        );
      if (!existing) {
        throw new StoreError("database", "Database error in insertSponsorship");
      }
      return { created: false, sponsorship: toSponsorship(existing) };
    },

    async getSponsorship(id) {
      const row = await getSponsorshipRow(id);
      return row ? toSponsorship(row) : null;
    },

    async getSponsorshipByThreadId(threadId) {
      const row = check(
        "getSponsorshipByThreadId",
        await db.from("sponsorships").select("*").eq("thread_id", threadId).maybeSingle(),
      );
      return row ? toSponsorship(row) : null;
    },

    async listSponsorships() {
      const rows = check(
        "listSponsorships",
        await db
          .from("sponsorships")
          .select("*, video:videos(id, title), branch:branches(id)")
          .order("received_at", { ascending: false })
          .order("id"),
      );
      return rows.map(({ video, branch, ...row }) => {
        const linkedVideo = one(video);
        return {
          ...toSponsorship(row),
          video: linkedVideo ? { id: linkedVideo.id, title: linkedVideo.title } : null,
          branchId: one(branch)?.id ?? null,
        };
      });
    },

    async recordSponsorReply(threadId, repliedAt) {
      if (!(repliedAt instanceof Date) || Number.isNaN(repliedAt.getTime())) {
        throw new StoreError("invalid_input", "Invalid reply time");
      }
      const rows = check(
        "recordSponsorReply",
        await db.rpc("record_sponsor_reply", { p_thread_id: threadId, p_replied_at: repliedAt.toISOString() }),
      );
      const row = one(rows);
      return row ? toSponsorship(row) : null;
    },

    async claimSponsorship(id, statuses) {
      return claimSponsorshipRow(id, statuses);
    },

    async claimNextSponsorship(statuses) {
      return claimSponsorshipRow(null, statuses);
    },

    async releaseSponsorship(id, input) {
      if (!isUuid(id)) {
        return null;
      }
      const rows = check("releaseSponsorship", await db.rpc("release_sponsorship", { p_id: id, ...releaseArgs(input) }));
      const row = one(rows);
      return row ? toSponsorship(row) : null;
    },

    async completeMatch(id, input) {
      if (!isUuid(id)) {
        return { status: "stale" };
      }
      if (!isUuid(input.videoId)) {
        const current = await getSponsorshipRow(id);
        return current && current.status === "matching" && current.lease_expires_at !== null
          ? { status: "video_missing" }
          : { status: "stale" };
      }
      const response = await settleSponsorship(id, "matching", "writing", {
        videoId: input.videoId,
        fitReason: input.fitReason,
        usage: input.usage,
      });
      if (response.error?.code === "23503") {
        return { status: "video_missing" };
      }
      const row = one(check("completeMatch", response));
      return row ? { status: "ok", sponsorship: toSponsorship(row) } : { status: "stale" };
    },

    async markNoFit(id, input) {
      return settleSponsorshipOrNull("markNoFit", id, input.from, "no_fit", {
        fitReason: input.reason,
        usage: input.usage,
      });
    },

    async markBranched(id, input) {
      return settleSponsorshipOrNull("markBranched", id, "writing", "branched", { usage: input?.usage });
    },

    async failSponsorship(id, input) {
      return settleSponsorshipOrNull("failSponsorship", id, input.from, "failed", {
        error: input.error,
        usage: input.usage,
      });
    },

    async retrySponsorship(id) {
      if (!isUuid(id)) {
        return null;
      }
      const row = one(check("retrySponsorship", await db.rpc("retry_sponsorship", { p_id: id })));
      return row ? toSponsorship(row) : null;
    },

    async matchSponsorshipAgain(id) {
      if (!isUuid(id)) {
        return null;
      }
      const row = check(
        "matchSponsorshipAgain",
        await db
          .from("sponsorships")
          .update({
            status: "matching",
            video_id: null,
            fit_reason: null,
            attempts: 0,
            lease_expires_at: null,
            error: null,
          })
          .eq("id", id)
          .eq("status", "no_fit")
          .select("*")
          .maybeSingle(),
      );
      return row ? toSponsorship(row) : null;
    },

    async insertBranch(input) {
      assertNewBranch(input);
      const existingBranch = async () =>
        check(
          "insertBranch",
          await db.from("branches").select("*").eq("sponsorship_id", input.sponsorshipId).maybeSingle(),
        );
      if (!isUuid(input.sponsorshipId)) {
        return { status: "sponsorship_missing" };
      }
      if (!isUuid(input.videoId)) {
        const existing = await existingBranch();
        if (existing) {
          return { status: "existing", branch: toBranch(existing) };
        }
        return (await getSponsorshipRow(input.sponsorshipId)) ? { status: "video_missing" } : { status: "sponsorship_missing" };
      }
      const response = await db
        .from("branches")
        .upsert(
          {
            video_id: input.videoId,
            sponsorship_id: input.sponsorshipId,
            base_script: input.baseScript,
            script: input.script,
            segment_summary: input.segmentSummary,
          },
          { onConflict: "sponsorship_id", ignoreDuplicates: true },
        )
        .select("*");
      if (response.error?.code === "23503") {
        return (await getSponsorshipRow(input.sponsorshipId)) ? { status: "video_missing" } : { status: "sponsorship_missing" };
      }
      const created = one(check("insertBranch", response));
      if (created) {
        return { status: "created", branch: toBranch(created) };
      }
      const existing = await existingBranch();
      if (!existing) {
        throw new StoreError("database", "Database error in insertBranch");
      }
      return { status: "existing", branch: toBranch(existing) };
    },

    async getBranch(id) {
      const row = await getBranchRow(id);
      return row ? toBranch(row) : null;
    },

    async getBranchBySponsorshipId(sponsorshipId) {
      if (!isUuid(sponsorshipId)) {
        return null;
      }
      const row = check(
        "getBranchBySponsorshipId",
        await db.from("branches").select("*").eq("sponsorship_id", sponsorshipId).maybeSingle(),
      );
      return row ? toBranch(row) : null;
    },

    async listBranchesForVideo(videoId) {
      if (!isUuid(videoId)) {
        return [];
      }
      const rows = check(
        "listBranchesForVideo",
        await db
          .from("branches")
          .select(`id, video_id, sponsorship_id, status, decided_at, created_at, updated_at, sponsorship:sponsorships(${SPONSOR_FIELDS})`)
          .eq("video_id", videoId)
          .order("created_at", { ascending: false })
          .order("id"),
      );
      return rows.map((row) => {
        const sponsorship = one(row.sponsorship);
        if (!sponsorship) {
          throw new StoreError("database", "Database error in listBranchesForVideo");
        }
        return {
          id: row.id,
          videoId: row.video_id,
          sponsorshipId: row.sponsorship_id,
          status: row.status,
          decidedAt: toDateOrNull(row.decided_at),
          createdAt: toDate(row.created_at),
          updatedAt: toDate(row.updated_at),
          brand: sponsorship.brand,
          fromName: sponsorship.from_name,
          fromEmail: sponsorship.from_email,
        };
      });
    },

    async updateBranchScript(id, script) {
      if (typeof script !== "string") {
        throw new StoreError("invalid_input", "Invalid branch script");
      }
      if (!isUuid(id)) {
        return { status: "not_found" };
      }
      const row = one(
        check("updateBranchScript", await db.rpc("update_branch_script", { p_branch_id: id, p_script: script })),
      );
      if (row) {
        return { status: "updated", branch: toBranch(row) };
      }
      return (await getBranchRow(id)) ? { status: "locked" } : { status: "not_found" };
    },

    async decideBranch(id, decision) {
      if (decision !== "approved" && decision !== "rejected") {
        throw new StoreError("invalid_input", "Invalid branch decision");
      }
      if (!isUuid(id)) {
        return { status: "not_found" };
      }
      const row = one(check("decideBranch", await db.rpc("decide_branch", { p_branch_id: id, p_status: decision })));
      if (row) {
        return { status: "ok", draft: toDraft(row) };
      }
      return (await getBranchRow(id)) ? { status: "locked" } : { status: "not_found" };
    },

    async getEmailDraft(id) {
      const row = await getDraftRow(id);
      return row ? toDraft(row) : null;
    },

    async getEmailDraftByBranchId(branchId) {
      if (!isUuid(branchId)) {
        return null;
      }
      const row = check(
        "getEmailDraftByBranchId",
        await db.from("email_drafts").select("*").eq("branch_id", branchId).maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async listEmailDrafts(view) {
      const query = db
        .from("email_drafts")
        .select(`*, branch:branches(video_id, sponsorship_id, sponsorship:sponsorships(${SPONSOR_FIELDS}, subject))`)
        .in("status", [...DRAFT_VIEW_STATUSES[view]]);
      const ordered =
        view === "sent"
          ? query.order("sent_at", { ascending: false }).order("id")
          : query.order("updated_at", { ascending: false }).order("id");
      const rows = check("listEmailDrafts", await ordered);
      return rows.map(({ branch, ...row }) => {
        const linkedBranch = one(branch);
        const sponsorship = one(linkedBranch?.sponsorship);
        if (!linkedBranch || !sponsorship) {
          throw new StoreError("database", "Database error in listEmailDrafts");
        }
        return {
          ...toDraft(row),
          videoId: linkedBranch.video_id,
          sponsorshipId: linkedBranch.sponsorship_id,
          brand: sponsorship.brand,
          fromName: sponsorship.from_name,
          fromEmail: sponsorship.from_email,
          threadSubject: sponsorship.subject,
        };
      });
    },

    async completeDraftGeneration(id, requestId, content) {
      if (!isUuid(id) || !isUuid(requestId)) {
        return null;
      }
      const row = check(
        "completeDraftGeneration",
        await db
          .from("email_drafts")
          .update({
            to_email: content.toEmail,
            cc: content.cc,
            subject: content.subject,
            body: content.body,
            status: "draft",
            error: null,
          })
          .eq("id", id)
          .eq("request_id", requestId)
          .eq("status", "generating")
          .select("*")
          .maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async failDraftGeneration(id, requestId, error) {
      if (!isUuid(id) || !isUuid(requestId)) {
        return null;
      }
      const row = check(
        "failDraftGeneration",
        await db
          .from("email_drafts")
          .update({ status: "failed", error: clampError(error) })
          .eq("id", id)
          .eq("request_id", requestId)
          .eq("status", "generating")
          .select("*")
          .maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async saveDraftEdits(id, edits) {
      if (!isUuid(id)) {
        return null;
      }
      const row = check(
        "saveDraftEdits",
        await db
          .from("email_drafts")
          .update({ to_email: edits.toEmail, cc: edits.cc, body: edits.body })
          .eq("id", id)
          .eq("status", "draft")
          .select("*")
          .maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async claimDraftSend(id) {
      if (!isUuid(id)) {
        return null;
      }
      const row = one(check("claimDraftSend", await db.rpc("claim_draft_send", { p_draft_id: id })));
      return row ? toDraft(row) : null;
    },

    async markDraftSent(id, input) {
      if (!isUuid(id)) {
        return null;
      }
      const row = check(
        "markDraftSent",
        await db
          .from("email_drafts")
          .update({
            status: "sent",
            gmail_message_id: input.gmailMessageId,
            sent_at: input.sentAt.toISOString(),
            error: null,
          })
          .eq("id", id)
          .eq("status", "sending")
          .select("*")
          .maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async releaseDraftSend(id, input) {
      if (!isUuid(id)) {
        return null;
      }
      const row = check(
        "releaseDraftSend",
        await db
          .from("email_drafts")
          .update({ status: "draft", sending_started_at: null, error: clampError(input.error) })
          .eq("id", id)
          .eq("status", "sending")
          .select("*")
          .maybeSingle(),
      );
      return row ? toDraft(row) : null;
    },

    async insertNotification(branchId) {
      if (!isUuid(branchId)) {
        return { status: "branch_missing" };
      }
      const response = await db
        .from("notifications")
        .upsert({ branch_id: branchId }, { onConflict: "branch_id", ignoreDuplicates: true })
        .select("*");
      if (response.error?.code === "23503") {
        return { status: "branch_missing" };
      }
      const created = one(check("insertNotification", response));
      if (created) {
        return { status: "created", notification: toNotification(created) };
      }
      const existing = check(
        "insertNotification",
        await db.from("notifications").select("*").eq("branch_id", branchId).maybeSingle(),
      );
      if (!existing) {
        throw new StoreError("database", "Database error in insertNotification");
      }
      return { status: "existing", notification: toNotification(existing) };
    },

    async listNotifications(limit) {
      const size = Math.max(0, Math.floor(limit));
      if (size === 0) {
        return [];
      }
      const rows = check(
        "listNotifications",
        await db
          .from("notifications")
          .select(`*, branch:branches(video_id, sponsorship:sponsorships(${SPONSOR_FIELDS}))`)
          .order("created_at", { ascending: false })
          .order("id")
          .limit(size),
      );
      return rows.map(({ branch, ...row }) => {
        const linkedBranch = one(branch);
        const sponsorship = one(linkedBranch?.sponsorship);
        if (!linkedBranch || !sponsorship) {
          throw new StoreError("database", "Database error in listNotifications");
        }
        return {
          ...toNotification(row),
          videoId: linkedBranch.video_id,
          brand: sponsorship.brand,
          fromName: sponsorship.from_name,
          fromEmail: sponsorship.from_email,
        };
      });
    },

    async countUnreadNotifications() {
      const { count, error } = await db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      if (error) {
        throw storeError("countUnreadNotifications", error);
      }
      return count ?? 0;
    },

    async markNotificationsRead(ids) {
      const valid = [...new Set(ids)].filter(isUuid);
      if (valid.length === 0) {
        return 0;
      }
      const rows = check(
        "markNotificationsRead",
        await db
          .from("notifications")
          .update({ read_at: clock.now().toISOString() })
          .in("id", valid)
          .is("read_at", null)
          .select("id"),
      );
      return rows.length;
    },

    async reclaimExpiredLeases() {
      const rows = check(
        "reclaimExpiredLeases",
        await db.rpc("reclaim_expired_leases", { p_max_attempts: MAX_ATTEMPTS, p_error: LEASE_EXPIRED_ERROR }),
      );
      const row = one(rows);
      return {
        inboxFailed: row?.inbox_failed ?? 0,
        inboxReleased: row?.inbox_released ?? 0,
        sponsorshipsFailed: row?.sponsorships_failed ?? 0,
        sponsorshipsReleased: row?.sponsorships_released ?? 0,
      };
    },
  };

  return store;
}
