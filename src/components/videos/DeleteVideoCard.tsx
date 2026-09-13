"use client";

import * as React from "react";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import { deleteVideo } from "@/app/(dashboard)/videos/actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  VIDEO_ACTION_MESSAGES,
  VIDEO_DELETE_BLOCKED,
  VIDEO_DELETE_CONFIRMATION,
  type DeleteVideoState,
} from "@/lib/videos/form";

const DELETE_FAILED = "The video was not deleted. Try again.";

// `blocked`: a reply for one of the video's branches is sending or sent, as the page read it.
// A reply that starts sending after that read is still refused inside the dialog.
export default function DeleteVideoCard({ videoId, blocked }: { videoId: string; blocked: boolean }) {
  const [open, setOpen] = React.useState(false);
  // A successful delete redirects to the video list, so the state only ever holds a refusal.
  const [state, dispatch, pending] = React.useActionState(deleteVideo, null);
  // The result that was on screen when the dialog last opened. It is not shown again.
  const [dismissed, setDismissed] = React.useState<DeleteVideoState | null>(null);
  const blockedId = React.useId();

  const result = state !== dismissed ? state : null;
  const error = result ? (result.error === "failed" ? DELETE_FAILED : VIDEO_ACTION_MESSAGES[result.error]) : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5} sx={{ alignItems: "flex-start" }}>
          <Typography variant="h6" component="h2">
            Delete video
          </Typography>
          {blocked ? (
            <Typography id={blockedId} variant="body2" sx={{ color: "text.secondary" }}>
              {VIDEO_DELETE_BLOCKED}
            </Typography>
          ) : null}
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteOutlinedIcon />}
            disabled={blocked}
            aria-describedby={blocked ? blockedId : undefined}
            onClick={() => {
              setDismissed(state);
              setOpen(true);
            }}
          >
            Delete video
          </Button>
        </Stack>
      </CardContent>
      <ConfirmDialog
        open={open}
        title="Delete this video?"
        description={VIDEO_DELETE_CONFIRMATION}
        confirmLabel="Delete"
        confirmColor="error"
        pending={pending}
        error={pending ? null : error}
        confirmDisabled={result?.error === "reply_sent" || result?.error === "not_found"}
        onConfirm={() => React.startTransition(() => dispatch(videoId))}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
