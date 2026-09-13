// Domain types and the Store port. Every page, Server Action, route and pipeline step
// reads and writes data through a Store. Two implementations share one contract suite:
// the Supabase store (server only) and the in-memory store (tests and demo mode).

export const INBOX_MESSAGE_STATUSES = [
  "pending",
  "not_sponsorship",
  "followup",
  "sponsorship",
  "skipped",
  "failed",
] as const;
export const SPONSORSHIP_STATUSES = ["matching", "writing", "branched", "no_fit", "failed"] as const;
export const BRANCH_STATUSES = ["pending", "approved", "rejected"] as const;
export const EMAIL_DRAFT_KINDS = ["accept", "decline"] as const;
export const EMAIL_DRAFT_STATUSES = ["generating", "draft", "failed", "sending", "sent"] as const;

export type InboxMessageStatus = (typeof INBOX_MESSAGE_STATUSES)[number];
export type InboxFinalStatus = Exclude<InboxMessageStatus, "pending">;
export type SponsorshipStatus = (typeof SPONSORSHIP_STATUSES)[number];
export type WorkingSponsorshipStatus = Extract<SponsorshipStatus, "matching" | "writing">;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];
export type BranchDecision = Exclude<BranchStatus, "pending">;
export type EmailDraftKind = (typeof EMAIL_DRAFT_KINDS)[number];
export type EmailDraftStatus = (typeof EMAIL_DRAFT_STATUSES)[number];
export type DraftsView = "drafts" | "sent";

// Limits shared by both stores, the database checks and later form validation.
export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 600;
export const ERROR_MAX_LENGTH = 500;
export const VIDEO_TITLE_MAX_LENGTH = 200;
export const VIDEO_SCRIPT_MAX_LENGTH = 60000;
export const LEASE_EXPIRED_ERROR = "Lease expired after the last attempt";
export const VIDEO_DELETED_REASON = "Video deleted";
export const DRAFT_VIEW_STATUSES: Record<DraftsView, readonly EmailDraftStatus[]> = {
  drafts: ["generating", "draft", "failed", "sending"],
  sent: ["sent"],
};

export function draftKindForDecision(decision: BranchDecision): EmailDraftKind {
  return decision === "approved" ? "accept" : "decline";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AppState {
  googleEmail: string | null;
  refreshTokenEnc: string | null;
  historyId: string | null;
  // null means not watching.
  watchExpiresAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  needsReauth: boolean;
  llmPausedReason: string | null;
  updatedAt: Date;
}

// history_id is not patchable: use setHistoryId or advanceHistoryId.
export type AppStatePatch = Partial<
  Pick<
    AppState,
    | "googleEmail"
    | "refreshTokenEnc"
    | "watchExpiresAt"
    | "lastCheckedAt"
    | "lastError"
    | "needsReauth"
    | "llmPausedReason"
  >
>;

export interface Video {
  id: string;
  title: string;
  script: string;
  monitoring: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface VideoSummary {
  id: string;
  title: string;
  monitoring: boolean;
  branchCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewVideo {
  title: string;
  script: string;
  monitoring?: boolean;
}

export type VideoPatch = Partial<Pick<Video, "title" | "script" | "monitoring">>;

export type DeleteVideoResult = "deleted" | "not_found" | "reply_sent";

// Holds no email content.
export interface InboxMessage {
  gmailMessageId: string;
  status: InboxMessageStatus;
  attempts: number;
  leaseExpiresAt: Date | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Offer {
  brand: string | null;
  product: string | null;
  deliverable: string | null;
  compensation: string | null;
  deadline: string | null;
  summary: string | null;
}

export interface NewSponsorship extends Offer {
  gmailMessageId: string;
  threadId: string;
  fromName: string | null;
  fromEmail: string;
  replyTo: string | null;
  cc: string[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
}

export interface Sponsorship extends NewSponsorship {
  id: string;
  status: SponsorshipStatus;
  videoId: string | null;
  fitReason: string | null;
  attempts: number;
  leaseExpiresAt: Date | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  lastReplyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SponsorshipListItem extends Sponsorship {
  video: { id: string; title: string } | null;
  branchId: string | null;
}

export interface NewBranch {
  videoId: string;
  sponsorshipId: string;
  baseScript: string;
  script: string;
  segmentSummary: string;
}

export interface Branch extends NewBranch {
  id: string;
  status: BranchStatus;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SponsorFields {
  brand: string | null;
  fromName: string | null;
  fromEmail: string;
}

export interface BranchListItem extends SponsorFields {
  id: string;
  videoId: string;
  sponsorshipId: string;
  status: BranchStatus;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftContent {
  toEmail: string;
  cc: string[];
  subject: string;
  body: string;
}

// The subject is locked to "Re: original subject", so it is not editable.
export type DraftEdits = Pick<DraftContent, "toEmail" | "cc" | "body">;

export interface EmailDraft {
  id: string;
  branchId: string;
  kind: EmailDraftKind;
  requestId: string;
  // The branch updated_at this draft was written from.
  basedOn: Date;
  toEmail: string | null;
  cc: string[];
  subject: string | null;
  body: string | null;
  status: EmailDraftStatus;
  error: string | null;
  sendingStartedAt: Date | null;
  gmailMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailDraftListItem extends EmailDraft, SponsorFields {
  videoId: string;
  sponsorshipId: string;
  threadSubject: string;
}

export interface Notification {
  id: string;
  branchId: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListItem extends Notification, SponsorFields {
  videoId: string;
}

export interface ReleaseInput {
  // transient: the attempt stays spent and the third failure fails the row.
  // account: the attempt is given back (Gmail reauth or AI paused).
  reason: "transient" | "account";
  error?: string | null;
  usage?: TokenUsage;
}

export interface SettleInboxInput {
  status: InboxFinalStatus;
  error?: string | null;
  usage?: TokenUsage;
}

export interface CompleteMatchInput {
  videoId: string;
  fitReason: string;
  usage?: TokenUsage;
}

export interface NoFitInput {
  from: WorkingSponsorshipStatus;
  reason: string;
  usage?: TokenUsage;
}

export interface FailSponsorshipInput {
  from: WorkingSponsorshipStatus;
  error: string;
  usage?: TokenUsage;
}

export interface ReclaimResult {
  inboxFailed: number;
  inboxReleased: number;
  sponsorshipsFailed: number;
  sponsorshipsReleased: number;
}

export type InsertSponsorshipResult = { created: boolean; sponsorship: Sponsorship };

export type CompleteMatchResult =
  | { status: "ok"; sponsorship: Sponsorship }
  | { status: "stale" }
  | { status: "video_missing" };

export type InsertBranchResult =
  | { status: "created" | "existing"; branch: Branch }
  | { status: "video_missing" }
  | { status: "sponsorship_missing" };

export type UpdateBranchScriptResult =
  | { status: "updated"; branch: Branch }
  | { status: "not_found" }
  | { status: "locked" };

export type DecideBranchResult =
  | { status: "ok"; draft: EmailDraft }
  | { status: "not_found" }
  | { status: "locked" };

export type InsertNotificationResult =
  | { status: "created" | "existing"; notification: Notification }
  | { status: "branch_missing" };

export class StoreError extends Error {
  readonly code: "invalid_input" | "database";

  constructor(code: StoreError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
  }
}

// Methods that take a row id return null (or a not_found result) for unknown ids,
// including ids that are not valid UUIDs. Guarded writes return null when the guard
// did not match, so a stale or duplicate caller changes nothing.
export interface Store {
  // App state (singleton)
  getAppState(): Promise<AppState>;
  updateAppState(patch: AppStatePatch): Promise<AppState>;
  setHistoryId(historyId: string | null): Promise<AppState>;
  // Moves history_id forward only (numeric compare). Returns true when it moved.
  advanceHistoryId(historyId: string): Promise<boolean>;

  // Videos
  listVideos(): Promise<VideoSummary[]>;
  listMonitoredVideos(): Promise<Video[]>;
  countMonitoredVideos(): Promise<number>;
  getVideo(id: string): Promise<Video | null>;
  createVideo(input: NewVideo): Promise<Video>;
  updateVideo(id: string, patch: VideoPatch): Promise<Video | null>;
  // True while a reply for one of the video's branches is sending or sent, which blocks
  // deleting the video.
  hasSendingOrSentReply(videoId: string): Promise<boolean>;
  // Blocked once a reply for one of its branches is sending or sent. Otherwise its
  // writing and branched sponsorships become no_fit "Video deleted", then its branches,
  // drafts and notifications are deleted and other sponsorships lose the video link.
  deleteVideo(id: string): Promise<DeleteVideoResult>;

  // Inbox messages
  // Inserts new ids as pending and ignores known ones. Returns how many were new.
  insertInboxMessages(gmailMessageIds: readonly string[]): Promise<number>;
  getInboxMessage(gmailMessageId: string): Promise<InboxMessage | null>;
  // A claim adds an attempt and a lease, only when pending, no live lease and
  // attempts below the limit.
  claimInboxMessage(gmailMessageId: string): Promise<InboxMessage | null>;
  claimNextInboxMessage(): Promise<InboxMessage | null>;
  releaseInboxMessage(gmailMessageId: string, input: ReleaseInput): Promise<InboxMessage | null>;
  settleInboxMessage(gmailMessageId: string, input: SettleInboxInput): Promise<InboxMessage | null>;

  // Sponsorships
  // Idempotent per Gmail message and per thread: a conflict returns the existing row.
  insertSponsorship(input: NewSponsorship): Promise<InsertSponsorshipResult>;
  getSponsorship(id: string): Promise<Sponsorship | null>;
  getSponsorshipByThreadId(threadId: string): Promise<Sponsorship | null>;
  listSponsorships(): Promise<SponsorshipListItem[]>;
  // Sets last_reply_at, only ever moving it forward.
  recordSponsorReply(threadId: string, repliedAt: Date): Promise<Sponsorship | null>;
  claimSponsorship(id: string, statuses: readonly WorkingSponsorshipStatus[]): Promise<Sponsorship | null>;
  claimNextSponsorship(statuses: readonly WorkingSponsorshipStatus[]): Promise<Sponsorship | null>;
  releaseSponsorship(id: string, input: ReleaseInput): Promise<Sponsorship | null>;
  // Claimed matching to writing with the video; attempts reset for the write step.
  completeMatch(id: string, input: CompleteMatchInput): Promise<CompleteMatchResult>;
  markNoFit(id: string, input: NoFitInput): Promise<Sponsorship | null>;
  markBranched(id: string, input?: { usage?: TokenUsage }): Promise<Sponsorship | null>;
  failSponsorship(id: string, input: FailSponsorshipInput): Promise<Sponsorship | null>;
  // Retry button: failed to writing when it still has a video, else matching.
  retrySponsorship(id: string): Promise<Sponsorship | null>;
  // Match again button: no_fit to matching.
  matchSponsorshipAgain(id: string): Promise<Sponsorship | null>;

  // Branches
  // Idempotent per sponsorship.
  insertBranch(input: NewBranch): Promise<InsertBranchResult>;
  getBranch(id: string): Promise<Branch | null>;
  getBranchBySponsorshipId(sponsorshipId: string): Promise<Branch | null>;
  listBranchesForVideo(videoId: string): Promise<BranchListItem[]>;
  // Locked once the reply is sending or sent. An unchanged script is not an edit.
  updateBranchScript(id: string, script: string): Promise<UpdateBranchScriptResult>;
  // Approve, Reject, Redraft and Retry: sets the decision and resets the draft to
  // generating with a new request_id and based_on. Locked once the reply is sending or sent.
  decideBranch(id: string, decision: BranchDecision): Promise<DecideBranchResult>;

  // Email drafts
  getEmailDraft(id: string): Promise<EmailDraft | null>;
  getEmailDraftByBranchId(branchId: string): Promise<EmailDraft | null>;
  listEmailDrafts(view: DraftsView): Promise<EmailDraftListItem[]>;
  // The draft job writes only while its request_id is current and the draft is generating.
  completeDraftGeneration(id: string, requestId: string, content: DraftContent): Promise<EmailDraft | null>;
  failDraftGeneration(id: string, requestId: string, error: string): Promise<EmailDraft | null>;
  saveDraftEdits(id: string, edits: DraftEdits): Promise<EmailDraft | null>;
  // draft to sending, only while the kind matches the branch decision.
  claimDraftSend(id: string): Promise<EmailDraft | null>;
  markDraftSent(id: string, input: { gmailMessageId: string; sentAt: Date }): Promise<EmailDraft | null>;
  // sending back to draft, after a Gmail error or when Check Gmail finds nothing.
  releaseDraftSend(id: string, input: { error: string | null }): Promise<EmailDraft | null>;

  // Notifications
  // Idempotent per branch.
  insertNotification(branchId: string): Promise<InsertNotificationResult>;
  listNotifications(limit: number): Promise<NotificationListItem[]>;
  countUnreadNotifications(): Promise<number>;
  // Marks the given unread notifications read. Returns how many changed.
  markNotificationsRead(ids: readonly string[]): Promise<number>;

  // Maintenance (daily cron): expired leases with no attempts left fail, the rest
  // become claimable. Failed rows are never touched.
  reclaimExpiredLeases(): Promise<ReclaimResult>;
}
