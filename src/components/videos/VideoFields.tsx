"use client";

import * as React from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import {
  VIDEO_FIELD_MESSAGES,
  isScriptTooLong,
  scriptCounter,
  type VideoField,
  type VideoFieldErrors,
} from "@/lib/videos/form";

const FIELD_IDS: Record<VideoField, string> = { title: "video-title", script: "video-script" };

// Moves focus to the first field with an error each time a submit returns field errors.
// Pass the errors object from the action state, so it changes only with a new result.
export function useFocusFirstInvalidField(errors: VideoFieldErrors | null): void {
  React.useEffect(() => {
    const field = errors?.title ? "title" : errors?.script ? "script" : null;
    if (field) {
      document.getElementById(FIELD_IDS[field])?.focus();
    }
  }, [errors]);
}

export interface VideoFieldsProps {
  title: string;
  script: string;
  errors: VideoFieldErrors;
  readOnly?: boolean;
  autoFocus?: boolean;
  onChange: (field: VideoField, value: string) => void;
}

// Title and script inputs with inline errors and a live character counter. Controlled by
// the parent form; the inputs keep their names so the form submits them as FormData.
export default function VideoFields({ title, script, errors, readOnly = false, autoFocus = false, onChange }: VideoFieldsProps) {
  const scriptError = errors.script ?? (isScriptTooLong(script) ? VIDEO_FIELD_MESSAGES.scriptTooLong : undefined);

  return (
    <Stack spacing={3}>
      <TextField
        id={FIELD_IDS.title}
        name="title"
        label="Title"
        value={title}
        onChange={(event) => onChange("title", event.target.value)}
        required
        fullWidth
        autoFocus={autoFocus}
        autoComplete="off"
        error={Boolean(errors.title)}
        helperText={errors.title}
        slotProps={{ htmlInput: { readOnly } }}
      />
      <TextField
        id={FIELD_IDS.script}
        name="script"
        label="Script"
        value={script}
        onChange={(event) => onChange("script", event.target.value)}
        multiline
        minRows={10}
        maxRows={28}
        fullWidth
        error={Boolean(scriptError)}
        helperText={
          <Box component="span" sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
            <span>{scriptError}</span>
            <Box component="span" sx={{ flexShrink: 0 }}>
              {scriptCounter(script)}
            </Box>
          </Box>
        }
        slotProps={{ htmlInput: { readOnly, spellCheck: true } }}
      />
    </Stack>
  );
}
