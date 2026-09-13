"use client";

import * as React from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import GoogleIcon from "@mui/icons-material/Google";
import { nextPathCookie } from "@/lib/auth/next-path";
import { AUTH_CALLBACK_PATH } from "@/lib/auth/routes";
import { GOOGLE_SIGN_IN_QUERY_PARAMS, GOOGLE_SIGN_IN_SCOPES } from "@/lib/auth/scopes";
import { createClient } from "@/lib/supabase/client";

export default function GoogleSignInButton({ next }: { next: string }) {
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    const supabase = createClient();
    if (!supabase) {
      setPending(false);
      setFailed(true);
      return;
    }
    document.cookie = nextPathCookie(next, window.location.protocol === "https:");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}`,
        scopes: GOOGLE_SIGN_IN_SCOPES,
        queryParams: { ...GOOGLE_SIGN_IN_QUERY_PARAMS },
      },
    });
    // On success the browser is already leaving for Google.
    if (error) {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <Stack spacing={2}>
      {failed ? <Alert severity="error">Sign in failed. Try again.</Alert> : null}
      <Button
        variant="contained"
        size="large"
        fullWidth
        startIcon={<GoogleIcon />}
        loading={pending}
        loadingPosition="start"
        onClick={signIn}
      >
        Sign in with Google
      </Button>
    </Stack>
  );
}
