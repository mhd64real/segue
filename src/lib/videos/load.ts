import "server-only";
import { notFound } from "next/navigation";
import type { Store, Video } from "@/lib/store/types";
import { parseVideoId } from "@/lib/videos/validation";

// For pages: a malformed or unknown video id renders the not found page.
export async function getVideoOrNotFound(store: Store, rawVideoId: string): Promise<Video> {
  const videoId = parseVideoId(rawVideoId);
  if (!videoId) {
    notFound();
  }
  const video = await store.getVideo(videoId);
  if (!video) {
    notFound();
  }
  return video;
}
