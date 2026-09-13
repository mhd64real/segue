import {
  ERROR_MAX_LENGTH,
  StoreError,
  VIDEO_SCRIPT_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
  type AppStatePatch,
  type NewBranch,
  type NewSponsorship,
  type NewVideo,
  type TokenUsage,
  type VideoPatch,
} from "@/lib/store/types";

// Input checks shared by every Store implementation, so both reject the same inputs
// before anything is written. The database has matching check constraints as a backstop.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_MAX_LENGTH = 200;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function invalid(message: string): StoreError {
  return new StoreError("invalid_input", message);
}

// Error columns hold only short messages of our own.
export function clampError(message: string | null | undefined): string | null {
  if (message === null || message === undefined) {
    return null;
  }
  if (message.length <= ERROR_MAX_LENGTH) {
    return message;
  }
  // Cut by code point so a surrogate pair is never split.
  return Array.from(message).slice(0, ERROR_MAX_LENGTH).join("");
}

export function normalizeUsage(usage: TokenUsage | undefined): TokenUsage {
  const clean = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 2_000_000_000) : 0;
  return { inputTokens: clean(usage?.inputTokens), outputTokens: clean(usage?.outputTokens) };
}

export function assertExternalId(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > EXTERNAL_ID_MAX_LENGTH) {
    throw invalid(`Invalid ${label}`);
  }
}

export function assertHistoryId(value: string): void {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw invalid("Invalid history id");
  }
}

function assertDate(value: Date | null, label: string): void {
  if (value !== null && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
    throw invalid(`Invalid ${label}`);
  }
}

function assertTitle(title: string): void {
  const length = typeof title === "string" ? title.trim().length : 0;
  if (length < 1 || length > VIDEO_TITLE_MAX_LENGTH) {
    throw invalid("Invalid video title");
  }
}

function assertScript(script: string): void {
  if (typeof script !== "string" || script.length > VIDEO_SCRIPT_MAX_LENGTH) {
    throw invalid("Invalid video script");
  }
}

export function assertNewVideo(input: NewVideo): void {
  assertTitle(input.title);
  assertScript(input.script);
}

export function assertVideoPatch(patch: VideoPatch): void {
  if (patch.title !== undefined) {
    assertTitle(patch.title);
  }
  if (patch.script !== undefined) {
    assertScript(patch.script);
  }
}

export function assertAppStatePatch(patch: AppStatePatch): void {
  assertDate(patch.watchExpiresAt ?? null, "watch expiry");
  assertDate(patch.lastCheckedAt ?? null, "last checked time");
  if (patch.lastError !== undefined && patch.lastError !== null && typeof patch.lastError !== "string") {
    throw invalid("Invalid last error");
  }
}

export function assertNewSponsorship(input: NewSponsorship): void {
  assertExternalId(input.gmailMessageId, "Gmail message id");
  assertExternalId(input.threadId, "thread id");
  if (typeof input.fromEmail !== "string" || input.fromEmail.length < 1) {
    throw invalid("Invalid sender");
  }
  if (!Array.isArray(input.cc)) {
    throw invalid("Invalid cc");
  }
  assertDate(input.receivedAt, "received time");
  if (!(input.receivedAt instanceof Date)) {
    throw invalid("Invalid received time");
  }
}

export function assertNewBranch(input: NewBranch): void {
  if (typeof input.baseScript !== "string" || typeof input.script !== "string" || typeof input.segmentSummary !== "string") {
    throw invalid("Invalid branch");
  }
}
