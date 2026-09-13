// The Gmail port: everything Segue needs from the owner's mailbox, as plain data. The
// Google implementation (src/lib/gmail/google.ts, server only) and the in-memory fake
// (src/lib/gmail/fake.ts) share one contract suite (src/lib/gmail/contract.ts).

export const GMAIL_INBOX_LABEL = "INBOX";
export const GMAIL_SENT_LABEL = "SENT";
export const GMAIL_DRAFT_LABEL = "DRAFT";
export const GMAIL_SPAM_LABEL = "SPAM";
export const GMAIL_TRASH_LABEL = "TRASH";

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface GmailWatch {
  // The mailbox history id when the watch started or was renewed.
  historyId: string;
  expiration: Date;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailAddedMessage extends GmailMessageRef {
  // Labels the message had when it was added.
  labelIds: string[];
}

export type GmailHistoryResult =
  // Messages in the order they were added, each once, and the history id to continue from.
  | { status: "ok"; messages: GmailAddedMessage[]; historyId: string }
  // The start id is too old for Gmail (HTTP 404). Fall back to listInboxAfter.
  | { status: "expired" };

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

// A message without its body, as a thread lists it.
export interface GmailMessageSummary {
  id: string;
  threadId: string;
  labelIds: string[];
  // When Gmail received the message. More reliable than the Date header.
  internalDate: Date;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  // RFC 822 Message-ID with angle brackets, for example "<abc@mail.example.com>".
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  // The Date header, when present and valid.
  date: Date | null;
}

export interface GmailMessage extends GmailMessageSummary {
  bodyText: string;
}

export interface GmailThread {
  id: string;
  // Oldest first.
  messages: GmailMessageSummary[];
}

export interface SendReplyInput {
  threadId: string;
  // Bare addresses, for example "partner@brand.example". To needs at least one.
  to: readonly string[];
  cc: readonly string[];
  // The thread subject. The reply gets exactly one "Re:" prefix.
  subject: string;
  bodyText: string;
  // Message-ID of the message being replied to. null when it had none.
  inReplyTo: string | null;
  // References of the message being replied to. The reply appends inReplyTo.
  references: readonly string[];
}

export interface SentMessage {
  id: string;
  threadId: string;
}

export interface GmailPort {
  // Starts or renews the push watch on INBOX.
  watch(topicName: string): Promise<GmailWatch>;
  stop(): Promise<void>;
  // Messages added to INBOX after startHistoryId, across every page.
  listHistory(startHistoryId: string): Promise<GmailHistoryResult>;
  // INBOX messages from the Gmail search after:<epoch seconds>, newest first, at most limit
  // (1 to 500). The boundary second is not exact, so callers must accept ids they already have.
  listInboxAfter(afterEpochSeconds: number, limit: number): Promise<GmailMessageRef[]>;
  getProfile(): Promise<GmailProfile>;
  getMessage(id: string): Promise<GmailMessage>;
  getThread(threadId: string): Promise<GmailThread>;
  sendReply(input: SendReplyInput): Promise<SentMessage>;
}

// Errors. Messages are fixed text of our own: never email content, addresses or tokens,
// so they are safe for logs and error columns.

export type GmailAuthReason =
  | "invalid_grant"
  | "unauthorized"
  | "insufficient_scope"
  | "client_rejected"
  | "missing_token"
  | "unreadable_token";

export type GmailTransientReason = "rate_limited" | "server_error" | "network" | "timeout";

export type GmailFailureReason =
  | "not_found"
  | "forbidden"
  | "bad_request"
  | "invalid_response"
  | "invalid_recipient"
  | "invalid_reply"
  | "unexpected";

export type GmailErrorReason = GmailAuthReason | GmailTransientReason | GmailFailureReason;

// For a failed sendReply: "not_sent" when Gmail refused it or was never asked, "unknown"
// when Gmail may have accepted it (network error, timeout, server error), so the caller
// has to look in the thread before sending again.
export type SendOutcome = "not_sent" | "unknown";

const MESSAGES: Record<GmailErrorReason, string> = {
  invalid_grant: "Google access was revoked or has expired",
  unauthorized: "Google did not accept the stored credentials",
  insufficient_scope: "Google access is missing a Gmail permission",
  client_rejected: "Google did not accept the OAuth client",
  missing_token: "No Google refresh token is stored",
  unreadable_token: "The stored Google refresh token cannot be decrypted",
  rate_limited: "Gmail rate limit reached",
  server_error: "Gmail had a server error",
  network: "Gmail could not be reached",
  timeout: "Gmail did not respond in time",
  not_found: "Gmail could not find the requested item",
  forbidden: "Gmail refused the request",
  bad_request: "Gmail rejected the request",
  invalid_response: "Gmail returned an unexpected response",
  invalid_recipient: "A reply recipient is not a valid email address",
  invalid_reply: "The reply is missing a required field",
  unexpected: "The Gmail request failed",
};

export interface GmailErrorOptions {
  status?: number | null;
  sendOutcome?: SendOutcome | null;
}

export class GmailError extends Error {
  readonly reason: GmailErrorReason;
  // HTTP status from Gmail or Google OAuth, when there was a response.
  readonly status: number | null;
  // Set on errors from sendReply only.
  readonly sendOutcome: SendOutcome | null;

  constructor(reason: GmailErrorReason, options: GmailErrorOptions = {}) {
    super(MESSAGES[reason]);
    this.name = "GmailError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.sendOutcome = options.sendOutcome ?? null;
  }
}

// Account level: callers pause Gmail work (needs_reauth) instead of failing items. Signing
// in with Google again stores a new token.
export class GmailAuthError extends GmailError {
  constructor(reason: GmailAuthReason, options: GmailErrorOptions = {}) {
    super(reason, options);
    this.name = "GmailAuthError";
  }
}

// Worth retrying later: rate limits, server errors, network errors and timeouts.
export class GmailTransientError extends GmailError {
  constructor(reason: GmailTransientReason, options: GmailErrorOptions = {}) {
    super(reason, options);
    this.name = "GmailTransientError";
  }
}

// The message or thread does not exist (deleted, or an unknown id).
export class GmailNotFoundError extends GmailError {
  constructor(options: GmailErrorOptions = {}) {
    super("not_found", options);
    this.name = "GmailNotFoundError";
  }
}

// Returns the same error with sendOutcome set, keeping its class.
export function withSendOutcome(error: GmailError, sendOutcome: SendOutcome): GmailError {
  if (error.sendOutcome === sendOutcome) {
    return error;
  }
  const options = { status: error.status, sendOutcome };
  if (error instanceof GmailAuthError) {
    return new GmailAuthError(error.reason as GmailAuthReason, options);
  }
  if (error instanceof GmailTransientError) {
    return new GmailTransientError(error.reason as GmailTransientReason, options);
  }
  if (error instanceof GmailNotFoundError) {
    return new GmailNotFoundError(options);
  }
  return new GmailError(error.reason, options);
}
