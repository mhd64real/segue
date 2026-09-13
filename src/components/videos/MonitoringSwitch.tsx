"use client";

import * as React from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { setVideoMonitoring } from "@/app/(dashboard)/videos/actions";
import { VIDEO_ACTION_MESSAGES } from "@/lib/videos/form";

export default function MonitoringSwitch({ videoId, monitoring }: { videoId: string; monitoring: boolean }) {
  const [state, dispatch, pending] = React.useActionState(setVideoMonitoring, null);
  // Shows the new position until the action finishes. The action revalidates the page, so
  // `monitoring` then holds the saved value, or the old one when saving failed.
  const [checked, setChecked] = React.useOptimistic(monitoring);
  const labelId = React.useId();
  const descriptionId = React.useId();
  const error = !pending && state?.ok === false ? VIDEO_ACTION_MESSAGES[state.error] : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography id={labelId} variant="h6" component="h2">
              Monitor sponsorships
            </Typography>
            <Typography id={descriptionId} variant="body2" sx={{ color: "text.secondary" }}>
              New sponsorship emails are checked against this video.
            </Typography>
          </Box>
          <Switch
            checked={checked}
            disabled={pending}
            onChange={(_event, next) => {
              React.startTransition(() => {
                setChecked(next);
                dispatch({ videoId, monitoring: next });
              });
            }}
            slotProps={{ input: { "aria-labelledby": labelId, "aria-describedby": descriptionId } }}
          />
        </Stack>
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
