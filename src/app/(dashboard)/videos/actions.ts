"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ownerStoreForAction } from "@/lib/owner";
import { EMAILS_PATH, SPONSORSHIPS_PATH, VIDEOS_PATH, videoPath } from "@/lib/paths";
import { StoreError, type DeleteVideoResult } from "@/lib/store/types";
import type {
  CreateVideoState,
  DeleteVideoState,
  Failed,
  MonitoringInput,
  MonitoringState,
  UpdateVideoState,
} from "@/lib/videos/form";
import { changeVideoMonitoring, removeVideo } from "@/lib/videos/lifecycle";
import { parseMonitoringInput, parseVideoContent, parseVideoId, parseVideoIdField } from "@/lib/videos/validation";

// Each action checks the owner first, then validates, and answers expected failures with a
// typed result for useActionState. A Store error becomes "failed"; anything else throws.

const FAILED: Failed = { ok: false, error: "failed" };
const NOT_FOUND = { ok: false, error: "not_found" } as const;

function storeFailure(action: string, error: unknown): Failed {
  if (!(error instanceof StoreError)) {
    throw error;
  }
  // StoreError messages are our own short text, never user content.
  console.error(`${action} failed: ${error.message}`);
  return FAILED;
}

function revalidateVideo(videoId: string) {
  revalidatePath(VIDEOS_PATH);
  revalidatePath(videoPath(videoId));
}

export async function createVideo(_previous: CreateVideoState | null, formData: FormData): Promise<CreateVideoState> {
  const owner = await ownerStoreForAction();
  if (!owner.ok) {
    return owner;
  }
  const input = parseVideoContent(formData);
  if (!input.ok) {
    return { ok: false, error: "invalid_input", fieldErrors: input.fieldErrors };
  }
  let videoId: string;
  try {
    videoId = (await owner.store.createVideo(input.data)).id;
  } catch (error) {
    return storeFailure("createVideo", error);
  }
  revalidatePath(VIDEOS_PATH);
  redirect(videoPath(videoId));
}

export async function updateVideo(_previous: UpdateVideoState | null, formData: FormData): Promise<UpdateVideoState> {
  const owner = await ownerStoreForAction();
  if (!owner.ok) {
    return owner;
  }
  const videoId = parseVideoIdField(formData);
  if (!videoId) {
    return NOT_FOUND;
  }
  const input = parseVideoContent(formData);
  if (!input.ok) {
    return { ok: false, error: "invalid_input", fieldErrors: input.fieldErrors };
  }
  try {
    const video = await owner.store.updateVideo(videoId, input.data);
    if (!video) {
      return NOT_FOUND;
    }
    revalidateVideo(video.id);
    return { ok: true, video: { id: video.id, title: video.title, script: video.script } };
  } catch (error) {
    return storeFailure("updateVideo", error);
  }
}

export async function setVideoMonitoring(
  _previous: MonitoringState | null,
  input: MonitoringInput,
): Promise<MonitoringState> {
  const owner = await ownerStoreForAction();
  if (!owner.ok) {
    return owner;
  }
  const parsed = parseMonitoringInput(input);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  try {
    const change = await changeVideoMonitoring({ store: owner.store }, parsed.data.videoId, parsed.data.monitoring);
    if (change.status === "not_found") {
      return NOT_FOUND;
    }
    revalidateVideo(change.video.id);
    return { ok: true, monitoring: change.video.monitoring };
  } catch (error) {
    return storeFailure("setVideoMonitoring", error);
  }
}

export async function deleteVideo(_previous: DeleteVideoState | null, rawVideoId: string): Promise<DeleteVideoState> {
  const owner = await ownerStoreForAction();
  if (!owner.ok) {
    return owner;
  }
  const videoId = parseVideoId(rawVideoId);
  if (!videoId) {
    return NOT_FOUND;
  }
  let result: DeleteVideoResult;
  try {
    result = await removeVideo({ store: owner.store }, videoId);
  } catch (error) {
    return storeFailure("deleteVideo", error);
  }
  if (result === "not_found") {
    return NOT_FOUND;
  }
  if (result === "reply_sent") {
    // The page read the video before the reply started sending. Rendering it again shows
    // the blocked Delete button once the dialog closes.
    revalidatePath(videoPath(videoId));
    return { ok: false, error: "reply_sent" };
  }
  revalidateVideo(videoId);
  // Deleting changes sponsorship statuses and removes drafts.
  revalidatePath(SPONSORSHIPS_PATH);
  revalidatePath(EMAILS_PATH);
  redirect(VIDEOS_PATH);
}
