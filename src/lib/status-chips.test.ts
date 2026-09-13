import { describe, expect, it } from "vitest";
import { BRANCH_STATUS_CHIPS, monitoringChip } from "@/lib/status-chips";
import { BRANCH_STATUSES } from "@/lib/store/types";

describe("status chips", () => {
  it("has a distinct label for every branch status", () => {
    expect(Object.keys(BRANCH_STATUS_CHIPS).sort()).toEqual([...BRANCH_STATUSES].sort());
    const labels = BRANCH_STATUSES.map((status) => BRANCH_STATUS_CHIPS[status].label);
    expect(new Set(labels).size).toBe(BRANCH_STATUSES.length);
  });

  it("shows monitoring on and off", () => {
    expect(monitoringChip(true)).toEqual({ label: "On", color: "success" });
    expect(monitoringChip(false)).toEqual({ label: "Off", color: "default" });
  });
});
