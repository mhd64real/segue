"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import type { ErrorInfo } from "next/error";

// Renders inside the dashboard shell when a page throws, for example a failed store read.
// The error text is not shown, since a library message can carry request details.
// retry() refreshes the route and renders the page again.
export default function DashboardError({ retry }: ErrorInfo) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" size="small" onClick={() => retry()}>
          Try again
        </Button>
      }
    >
      This page did not load.
    </Alert>
  );
}
