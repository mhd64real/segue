"use client";

import * as React from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import { createVideo } from "@/app/(dashboard)/videos/actions";
import LinkButton from "@/components/LinkButton";
import { useUnsavedChanges } from "@/components/NavigationGuardProvider";
import VideoFields, { useFocusFirstInvalidField } from "@/components/videos/VideoFields";
import { VIDEOS_PATH } from "@/lib/paths";
import { dispatchFormData } from "@/lib/form-submit";
import {
  VIDEO_ACTION_MESSAGES,
  isVideoDirty,
  visibleErrors,
  type VideoContent,
  type VideoField,
  type VideoFieldErrors,
} from "@/lib/videos/form";

const CREATE_FAILED = "The video was not created. Try again.";
const EMPTY_VIDEO: VideoContent = { title: "", script: "" };

export default function NewVideoForm() {
  const [values, setValues] = React.useState<VideoContent>(EMPTY_VIDEO);
  const [state, dispatch, pending] = React.useActionState(createVideo, null);
  const [edited, setEdited] = React.useState<ReadonlySet<VideoField>>(() => new Set());
  useUnsavedChanges(isVideoDirty(values, EMPTY_VIDEO));

  const submittedErrors = state?.error === "invalid_input" ? state.fieldErrors : null;
  const fieldErrors: VideoFieldErrors = submittedErrors ?? {};
  useFocusFirstInvalidField(submittedErrors);
  const formError =
    state?.error === "failed"
      ? CREATE_FAILED
      : state && state.error !== "invalid_input"
        ? VIDEO_ACTION_MESSAGES[state.error]
        : null;

  return (
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
      <VideoFields
        title={values.title}
        script={values.script}
        errors={visibleErrors(fieldErrors, edited)}
        readOnly={pending}
        autoFocus
        onChange={(field, value) => {
          setValues((current) => ({ ...current, [field]: value }));
          setEdited((current) => new Set(current).add(field));
        }}
      />
      {formError ? <Alert severity="error">{formError}</Alert> : null}
      <Stack direction="row" spacing={1.5} sx={{ justifyContent: "flex-end" }}>
        <LinkButton href={VIDEOS_PATH} disabled={pending}>
          Cancel
        </LinkButton>
        <Button type="submit" variant="contained" loading={pending}>
          Create
        </Button>
      </Stack>
    </Stack>
  );
}
