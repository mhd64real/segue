import { z } from "zod";

// Gmail permissions Segue needs. Safe for any runtime: the sign-in button requests them
// and the callback checks them.

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const REQUIRED_GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] as const;
export const GOOGLE_SIGN_IN_SCOPES = REQUIRED_GMAIL_SCOPES.join(" ");
export const GOOGLE_SIGN_IN_QUERY_PARAMS = { access_type: "offline", prompt: "consent" } as const;

export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const TOKENINFO_TIMEOUT_MS = 10_000;

export type ScopeCheck =
  | { status: "granted" }
  | { status: "missing"; missing: string[] }
  // Google could not be asked or did not accept the token.
  | { status: "error" };

const tokenInfoSchema = z.object({ scope: z.string() });

export function missingGmailScopes(grantedScope: string): string[] {
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
  return REQUIRED_GMAIL_SCOPES.filter((scope) => !granted.has(scope));
}

// Asks Google which scopes the access token carries. The user can untick Gmail send on
// the consent screen, so the granted list can be shorter than the requested one.
export async function checkGmailScopes(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TOKENINFO_TIMEOUT_MS,
): Promise<ScopeCheck> {
  if (!accessToken) {
    return { status: "error" };
  }
  try {
    const response = await fetchImpl(GOOGLE_TOKENINFO_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { status: "error" };
    }
    const parsed = tokenInfoSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { status: "error" };
    }
    const missing = missingGmailScopes(parsed.data.scope);
    return missing.length === 0 ? { status: "granted" } : { status: "missing", missing };
  } catch {
    return { status: "error" };
  }
}
