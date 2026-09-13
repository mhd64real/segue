// Dashboard paths shared by pages, links, redirects and revalidation.

export const VIDEOS_PATH = "/videos";
export const NEW_VIDEO_PATH = "/videos/new";
export const SPONSORSHIPS_PATH = "/sponsorships";
export const EMAILS_PATH = "/emails";

export function videoPath(videoId: string): string {
  return `${VIDEOS_PATH}/${encodeURIComponent(videoId)}`;
}
