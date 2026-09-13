"use client";

import NextLink from "next/link";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import StatusChip from "@/components/StatusChip";
import { videoPath } from "@/lib/paths";
import { monitoringChip } from "@/lib/status-chips";
import type { VideoRow } from "@/lib/videos/view";

// Branches and Updated get their own columns from the sm breakpoint. On phones they move
// under the title, so the table never scrolls sideways.
const WIDE_ONLY = { display: { xs: "none", sm: "table-cell" } } as const;

function branchLabel(count: number): string {
  return count === 1 ? "1 branch" : `${count} branches`;
}

export default function VideosTable({ rows }: { rows: VideoRow[] }) {
  return (
    <Paper variant="outlined">
      <TableContainer>
        <Table aria-label="Videos">
          <TableHead>
            <TableRow>
              <TableCell>Title</TableCell>
              <TableCell sx={{ width: "1%" }}>Monitoring</TableCell>
              <TableCell align="right" sx={{ ...WIDE_ONLY, width: "1%" }}>
                Branches
              </TableCell>
              <TableCell sx={{ ...WIDE_ONLY, width: "1%", whiteSpace: "nowrap" }}>Updated</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} hover sx={{ "&:last-child td": { borderBottom: 0 } }}>
                <TableCell sx={{ overflowWrap: "anywhere" }}>
                  <Link component={NextLink} href={videoPath(row.id)} underline="hover" sx={{ fontWeight: "fontWeightMedium" }}>
                    {row.title}
                  </Link>
                  <Typography variant="body2" sx={{ color: "text.secondary", display: { sm: "none" }, mt: 0.5 }}>
                    {branchLabel(row.branchCount)}, updated {row.updated}
                  </Typography>
                </TableCell>
                <TableCell>
                  <StatusChip {...monitoringChip(row.monitoring)} />
                </TableCell>
                <TableCell align="right" sx={WIDE_ONLY}>
                  {row.branchCount}
                </TableCell>
                <TableCell sx={{ ...WIDE_ONLY, whiteSpace: "nowrap" }}>
                  <time dateTime={row.updatedAt}>{row.updated}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
