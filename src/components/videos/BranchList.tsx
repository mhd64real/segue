import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import StatusChip from "@/components/StatusChip";
import type { BranchRow } from "@/lib/videos/view";

export default function BranchList({ branches }: { branches: BranchRow[] }) {
  if (branches.length === 0) {
    return <Typography sx={{ color: "text.secondary" }}>No branches yet.</Typography>;
  }
  return (
    <List disablePadding aria-label="Branches">
      {branches.map((branch, index) => (
        <ListItem key={branch.id} disableGutters divider={index < branches.length - 1} sx={{ gap: 2 }}>
          <ListItemText
            sx={{ minWidth: 0, overflowWrap: "anywhere" }}
            primary={branch.sponsor}
            secondary={
              <>
                Created <time dateTime={branch.createdAt}>{branch.created}</time>
              </>
            }
          />
          <StatusChip {...branch.status} />
        </ListItem>
      ))}
    </List>
  );
}
