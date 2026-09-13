import { formatRelativeTime } from "@/lib/format/relative-time";
import { BRANCH_STATUS_CHIPS, type StatusChipSpec } from "@/lib/status-chips";
import type { BranchListItem, VideoSummary } from "@/lib/store/types";

// Plain rows for the video screens. Relative times are computed on the server with one
// `now`, so the client renders the same text and nothing mismatches on hydration.

export interface VideoRow {
  id: string;
  title: string;
  monitoring: boolean;
  branchCount: number;
  updated: string;
  updatedAt: string;
}

export interface BranchRow {
  id: string;
  sponsor: string;
  status: StatusChipSpec;
  created: string;
  createdAt: string;
}

export function toVideoRows(videos: readonly VideoSummary[], now: Date): VideoRow[] {
  return videos.map((video) => ({
    id: video.id,
    title: video.title,
    monitoring: video.monitoring,
    branchCount: video.branchCount,
    updated: formatRelativeTime(video.updatedAt, now),
    updatedAt: video.updatedAt.toISOString(),
  }));
}

// The brand when the offer named one, otherwise the sender.
export function sponsorLabel(branch: Pick<BranchListItem, "brand" | "fromName" | "fromEmail">): string {
  return branch.brand?.trim() || branch.fromName?.trim() || branch.fromEmail;
}

export function toBranchRows(branches: readonly BranchListItem[], now: Date): BranchRow[] {
  return branches.map((branch) => ({
    id: branch.id,
    sponsor: sponsorLabel(branch),
    status: BRANCH_STATUS_CHIPS[branch.status],
    created: formatRelativeTime(branch.createdAt, now),
    createdAt: branch.createdAt.toISOString(),
  }));
}
