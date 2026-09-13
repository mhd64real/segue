import type { Unauthorized } from "@/lib/owner";
import { VIDEO_SCRIPT_MAX_LENGTH, VIDEO_TITLE_MAX_LENGTH } from "@/lib/store/types";

// Video form rules and action result types shared by the Server Actions and the client
// forms. No server code and no zod here, so client components can import it.

export type VideoField = "title" | "script";
export type VideoFieldErrors = Partial<Record<VideoField, string>>;

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export const VIDEO_FIELD_MESSAGES = {
  titleRequired: "Title is required.",
  titleTooLong: `Title must be ${formatCount(VIDEO_TITLE_MAX_LENGTH)} characters or fewer.`,
  scriptInvalid: "Script must be text.",
  scriptTooLong: `Script must be ${formatCount(VIDEO_SCRIPT_MAX_LENGTH)} characters or fewer.`,
} as const;

export function normalizeTitle(title: string): string {
  return title.trim();
}

// Browsers may submit textarea line breaks as CRLF. Scripts are stored with LF, so the
// length check matches the counter the owner saw.
export function normalizeScript(script: string): string {
  return script.replace(/\r\n?/g, "\n");
}

export function scriptCounter(script: string): string {
  return `${formatCount(script.length)} / ${formatCount(VIDEO_SCRIPT_MAX_LENGTH)}`;
}

export function isScriptTooLong(script: string): boolean {
  return normalizeScript(script).length > VIDEO_SCRIPT_MAX_LENGTH;
}

export interface VideoContent {
  title: string;
  script: string;
}

export type InvalidFields = { ok: false; error: "invalid_input"; fieldErrors: VideoFieldErrors };
export type InvalidInput = { ok: false; error: "invalid_input" };
export type NotFound = { ok: false; error: "not_found" };
export type ReplySent = { ok: false; error: "reply_sent" };
export type Failed = { ok: false; error: "failed" };

export interface SavedVideo extends VideoContent {
  id: string;
}

export interface MonitoringInput {
  videoId: string;
  monitoring: boolean;
}

// Successful create and delete redirect, so they have no success result.
export type CreateVideoState = Unauthorized | InvalidFields | Failed;
export type UpdateVideoState = { ok: true; video: SavedVideo } | Unauthorized | InvalidFields | NotFound | Failed;
export type MonitoringState = { ok: true; monitoring: boolean } | Unauthorized | InvalidInput | NotFound | Failed;
export type DeleteVideoState = Unauthorized | NotFound | ReplySent | Failed;

export type VideoActionError = Exclude<
  CreateVideoState | UpdateVideoState | MonitoringState | DeleteVideoState,
  { ok: true }
>["error"];

export const VIDEO_ACTION_MESSAGES: Record<VideoActionError, string> = {
  unauthorized: "You are signed out. Sign in again to continue.",
  invalid_input: "Some fields need changes.",
  not_found: "This video no longer exists.",
  reply_sent: "This video cannot be deleted because a reply for one of its branches was sent.",
  failed: "The change was not saved. Try again.",
};

// States the Store delete rules: only writing and branched sponsorships become No fit. A
// failed one stays Failed and only loses its video.
export const VIDEO_DELETE_CONFIRMATION =
  "The video, its branches and their drafts are removed. Sponsorships branched or being branched on it are marked No fit.";

// Shown under a disabled Delete button while a reply for one of the video's branches is
// sending or sent.
export const VIDEO_DELETE_BLOCKED = "A reply for one of its branches was sent.";

export function isVideoDirty(current: VideoContent, saved: VideoContent): boolean {
  return current.title !== saved.title || current.script !== saved.script;
}

// Field errors from the last submit, minus the fields edited since then.
export function visibleErrors(errors: VideoFieldErrors, edited: ReadonlySet<VideoField>): VideoFieldErrors {
  const visible: VideoFieldErrors = {};
  for (const field of ["title", "script"] as const) {
    if (errors[field] && !edited.has(field)) {
      visible[field] = errors[field];
    }
  }
  return visible;
}
