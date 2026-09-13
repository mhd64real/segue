import Chip from "@mui/material/Chip";
import type { StatusChipSpec } from "@/lib/status-chips";

export default function StatusChip({ label, color }: StatusChipSpec) {
  return <Chip size="small" variant="outlined" color={color} label={label} />;
}
