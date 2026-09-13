import { describe, expect, it } from "vitest";
import type { BranchListItem, VideoSummary } from "@/lib/store/types";
import { sponsorLabel, toBranchRows, toVideoRows } from "@/lib/videos/view";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("video rows", () => {
  it("keeps the list fields and adds relative update times", () => {
    const video: VideoSummary = {
      id: "v1",
      title: "Title",
      monitoring: true,
      branchCount: 2,
      createdAt: new Date(NOW.getTime() - 10 * DAY),
      updatedAt: new Date(NOW.getTime() - 2 * DAY),
    };
    expect(toVideoRows([video], NOW)).toEqual([
      {
        id: "v1",
        title: "Title",
        monitoring: true,
        branchCount: 2,
        updated: "2 days ago",
        updatedAt: "2026-09-12T12:00:00.000Z",
      },
    ]);
  });
});

describe("branch rows", () => {
  const branch: BranchListItem = {
    id: "b1",
    videoId: "v1",
    sponsorshipId: "s1",
    status: "approved",
    decidedAt: null,
    createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
    updatedAt: NOW,
    brand: "Meshwave",
    fromName: "Priya Raman",
    fromEmail: "priya@meshwave.example",
  };

  it("names the brand, then the sender name, then the sender address", () => {
    expect(sponsorLabel(branch)).toBe("Meshwave");
    expect(sponsorLabel({ ...branch, brand: null })).toBe("Priya Raman");
    expect(sponsorLabel({ ...branch, brand: "  ", fromName: null })).toBe("priya@meshwave.example");
  });

  it("adds the status chip and relative creation time", () => {
    expect(toBranchRows([branch], NOW)).toEqual([
      {
        id: "b1",
        sponsor: "Meshwave",
        status: { label: "Approved", color: "success" },
        created: "3 hours ago",
        createdAt: "2026-09-14T09:00:00.000Z",
      },
    ]);
  });
});
