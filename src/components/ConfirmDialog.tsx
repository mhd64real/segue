"use client";

import * as React from "react";
import Alert from "@mui/material/Alert";
import Button, { type ButtonProps } from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  confirmColor?: ButtonProps["color"];
  // While pending the dialog cannot be dismissed and the confirm button shows progress.
  pending?: boolean;
  // Shown inside the dialog, for example why the action was refused.
  error?: string | null;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmColor = "primary",
  pending = false,
  error = null,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const descriptionId = React.useId();

  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {description ? <DialogContentText id={descriptionId}>{description}</DialogContentText> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant="contained" color={confirmColor} loading={pending} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
