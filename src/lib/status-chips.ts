import type { ChipProps } from "@mui/material/Chip";
import type { BranchStatus } from "@/lib/store/types";

// Labels and colors for the small status chips, one map per kind of status. Rendered
// with src/components/StatusChip.tsx.

export interface StatusChipSpec {
  label: string;
  color: NonNullable<ChipProps["color"]>;
}

export const BRANCH_STATUS_CHIPS: Record<BranchStatus, StatusChipSpec> = {
  pending: { label: "Pending", color: "default" },
  approved: { label: "Approved", color: "success" },
  rejected: { label: "Rejected", color: "error" },
};

export function monitoringChip(monitoring: boolean): StatusChipSpec {
  return monitoring ? { label: "On", color: "success" } : { label: "Off", color: "default" };
}
