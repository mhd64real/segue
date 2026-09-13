"use client";

import * as React from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import { updateVideo } from "@/app/(dashboard)/videos/actions";
import { useUnsavedChanges } from "@/components/NavigationGuardProvider";
import VideoFields, { useFocusFirstInvalidField } from "@/components/videos/VideoFields";
import { dispatchFormData } from "@/lib/form-submit";
import {
  VIDEO_ACTION_MESSAGES,
  isVideoDirty,
  visibleErrors,
  type SavedVideo,
  type UpdateVideoState,
  type VideoContent,
  type VideoField,
  type VideoFieldErrors,
} from "@/lib/videos/form";

export default function VideoEditor({ video }: { video: SavedVideo }) {
  const [saved, setSaved] = React.useState<VideoContent>({ title: video.title, script: video.script });
  const [values, setValues] = React.useState<VideoContent>(saved);
  const [edited, setEdited] = React.useState<ReadonlySet<VideoField>>(() => new Set());
  const [savedNotice, setSavedNotice] = React.useState(false);

  const [state, dispatch, pending] = React.useActionState(
    async (previous: UpdateVideoState | null, formData: FormData): Promise<UpdateVideoState> => {
      const result = await updateVideo(previous, formData);
      if (result.ok) {
        // The server trims the title and normalizes line breaks; show exactly what was saved.
        const content = { title: result.video.title, script: result.video.script };
        setSaved(content);
        setValues(content);
        setSavedNotice(true);
      }
      return result;
    },
    null,
  );

  const dirty = isVideoDirty(values, saved);
  useUnsavedChanges(dirty);
  const submittedErrors = state?.ok === false && state.error === "invalid_input" ? state.fieldErrors : null;
  const fieldErrors: VideoFieldErrors = submittedErrors ?? {};
  useFocusFirstInvalidField(submittedErrors);
  const formError = state?.ok === false && state.error !== "invalid_input" ? VIDEO_ACTION_MESSAGES[state.error] : null;

  return (
    <>
      <Stack
        component="form"
        action={dispatch}
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          setEdited(new Set());
          dispatchFormData(event, dispatch);
        }}
        noValidate
        spacing={3}
      >
        <input type="hidden" name="videoId" value={video.id} />
        <VideoFields
          title={values.title}
          script={values.script}
          errors={visibleErrors(fieldErrors, edited)}
          readOnly={pending}
          onChange={(field, value) => {
            setValues((current) => ({ ...current, [field]: value }));
            setEdited((current) => new Set(current).add(field));
          }}
        />
        {formError && !pending ? <Alert severity="error">{formError}</Alert> : null}
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <Button type="submit" variant="contained" loading={pending} disabled={!dirty}>
            Save
          </Button>
        </Stack>
      </Stack>
      <Snackbar
        open={savedNotice}
        autoHideDuration={4000}
        onClose={() => setSavedNotice(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message="Video saved"
      />
    </>
  );
}
