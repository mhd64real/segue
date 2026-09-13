import "server-only";
import type { DeleteVideoResult, Store, Video } from "@/lib/store/types";

// Video changes that have side effects beyond the row itself. Every caller goes through
// these, so the rules live in one place. Phase 5 extends the deps with Gmail and starts,
// renews or stops the watch here.

export interface VideoDeps {
  store: Store;
}

export type MonitoringChange = { status: "ok"; video: Video } | { status: "not_found" };

// Saves the monitoring flag.
export async function changeVideoMonitoring(deps: VideoDeps, videoId: string, monitoring: boolean): Promise<MonitoringChange> {
  const video = await deps.store.updateVideo(videoId, { monitoring });
  return video ? { status: "ok", video } : { status: "not_found" };
}

// The Store applies the delete rules atomically: blocked once a reply for one of the
// video's branches is sending or sent, otherwise its writing and branched sponsorships
// become no_fit "Video deleted" and the video, branches, drafts and notifications go.
export async function removeVideo(deps: VideoDeps, videoId: string): Promise<DeleteVideoResult> {
  return deps.store.deleteVideo(videoId);
}
