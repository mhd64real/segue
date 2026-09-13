import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { APP_NAME } from "@/config";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { getSignInReadiness } from "@/lib/auth/readiness";
import { DEFAULT_NEXT_PATH, parseLoginError, type LoginError } from "@/lib/auth/routes";
import { isDemoMode } from "@/lib/demo/guard";
import { resolveOwner } from "@/lib/owner";

export const metadata: Metadata = {
  title: `Sign in to ${APP_NAME}`,
};

const ERROR_MESSAGES: Record<Exclude<LoginError, "not_configured">, string> = {
  not_allowed: "This Google account is not allowed.",
  missing_permissions: "Gmail read and send permissions were not granted. Sign in again and allow both.",
  no_refresh_token: "Google did not grant offline access. Sign in again.",
  sign_in_failed: "Sign in failed. Try again.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const error = parseLoginError(first(params.error));
  const next = sanitizeNextPath(first(params.next));
  const demo = isDemoMode();

  let content: React.ReactNode;
  if (demo) {
    content = (
      <>
        <Typography sx={{ color: "text.secondary" }}>Demo mode runs on sample data. Nothing is sent.</Typography>
        <Button variant="contained" size="large" fullWidth href={DEFAULT_NEXT_PATH}>
          Continue to demo
        </Button>
      </>
    );
  } else {
    const readiness = await getSignInReadiness();
    if (readiness === "not_configured" || error === "not_configured") {
      content = (
        <Alert severity="info">
          <AlertTitle>Setup is not finished</AlertTitle>
          Sign in is not available yet.
        </Alert>
      );
    } else {
      if (!error) {
        const resolution = await resolveOwner();
        if (resolution.status === "owner") {
          redirect(next);
        }
      }
      content = (
        <>
          <Typography sx={{ color: "text.secondary" }}>Sign in with the Google account for this channel.</Typography>
          {error ? <Alert severity="error">{ERROR_MESSAGES[error]}</Alert> : null}
          <GoogleSignInButton next={next} />
        </>
      );
    }
  }

  return (
    <Box
      component="main"
      sx={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}
    >
      <Card variant="outlined" sx={{ width: "100%", maxWidth: 420 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={3}>
            <Typography variant="h5" component="h1">
              {APP_NAME}
            </Typography>
            {content}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
