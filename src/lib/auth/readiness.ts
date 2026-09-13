import "server-only";
import { z } from "zod";
import { isEnvConfigured, readEnv, type EnvGroupName } from "@/lib/env";

// Whether the sign-in button can work end to end. Sign in needs the Supabase keys, the
// allowlist, the token encryption key, and the Google provider switched on in Supabase.

export type SignInReadiness = "ready" | "not_configured";

export const SIGN_IN_ENV_GROUPS: readonly EnvGroupName[] = ["supabasePublic", "supabaseAdmin", "owner", "tokenEncryption"];

const SETTINGS_TIMEOUT_MS = 5_000;

const settingsSchema = z.object({ external: z.object({ google: z.boolean() }) });

// Reads the public Supabase Auth settings. Returns null when they cannot be read.
export async function isGoogleProviderEnabled(
  env: { url: string; publishableKey: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SETTINGS_TIMEOUT_MS,
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(`${env.url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: env.publishableKey },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const parsed = settingsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.external.google : null;
  } catch {
    return null;
  }
}

// When the settings cannot be read the button still shows, and a failed sign in reports
// itself. Only a provider that Supabase says is off counts as not configured.
export async function getSignInReadiness(fetchImpl: typeof fetch = fetch): Promise<SignInReadiness> {
  if (!SIGN_IN_ENV_GROUPS.every((group) => isEnvConfigured(group))) {
    return "not_configured";
  }
  const supabase = readEnv("supabasePublic");
  if (!supabase) {
    return "not_configured";
  }
  const google = await isGoogleProviderEnabled(supabase, fetchImpl);
  return google === false ? "not_configured" : "ready";
}
