import { z } from "zod";
import { VIDEO_SCRIPT_MAX_LENGTH, VIDEO_TITLE_MAX_LENGTH } from "@/lib/store/types";
import { isUuid } from "@/lib/store/validation";
import {
  VIDEO_FIELD_MESSAGES,
  normalizeScript,
  normalizeTitle,
  type MonitoringInput,
  type VideoContent,
  type VideoFieldErrors,
} from "@/lib/videos/form";

// Server-side parsing of untrusted action input. Error text is always one of our fixed
// field messages, never a zod issue or any part of the input.

const titleSchema = z
  .string({ error: VIDEO_FIELD_MESSAGES.titleRequired })
  .overwrite(normalizeTitle)
  .min(1, { error: VIDEO_FIELD_MESSAGES.titleRequired })
  .max(VIDEO_TITLE_MAX_LENGTH, { error: VIDEO_FIELD_MESSAGES.titleTooLong });

const scriptSchema = z
  .string({ error: VIDEO_FIELD_MESSAGES.scriptInvalid })
  .overwrite(normalizeScript)
  .max(VIDEO_SCRIPT_MAX_LENGTH, { error: VIDEO_FIELD_MESSAGES.scriptTooLong });

const videoContentSchema = z.object({ title: titleSchema, script: scriptSchema });

// Ids are canonical lowercase UUIDs, so both stores agree on what exists.
const videoIdSchema = z
  .string()
  .max(36)
  .refine(isUuid)
  .transform((id) => id.toLowerCase());

const monitoringSchema = z.boolean();

export type ParsedContent = { ok: true; data: VideoContent } | { ok: false; fieldErrors: VideoFieldErrors };

export function parseVideoContent(formData: unknown): ParsedContent {
  const raw = formData instanceof FormData ? { title: formData.get("title"), script: formData.get("script") } : {};
  const result = videoContentSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const flattened = z.flattenError(result.error).fieldErrors;
  const fieldErrors: VideoFieldErrors = {};
  if (flattened.title?.[0]) {
    fieldErrors.title = flattened.title[0];
  }
  if (flattened.script?.[0]) {
    fieldErrors.script = flattened.script[0];
  }
  return { ok: false, fieldErrors };
}

export function parseVideoId(value: unknown): string | null {
  const result = videoIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseVideoIdField(formData: unknown): string | null {
  return formData instanceof FormData ? parseVideoId(formData.get("videoId")) : null;
}

export type ParsedMonitoring =
  | { ok: true; data: MonitoringInput }
  | { ok: false; error: "not_found" | "invalid_input" };

export function parseMonitoringInput(input: unknown): ParsedMonitoring {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const videoId = parseVideoId(record.videoId);
  if (!videoId) {
    return { ok: false, error: "not_found" };
  }
  const monitoring = monitoringSchema.safeParse(record.monitoring);
  if (!monitoring.success) {
    return { ok: false, error: "invalid_input" };
  }
  return { ok: true, data: { videoId, monitoring: monitoring.data } };
}
