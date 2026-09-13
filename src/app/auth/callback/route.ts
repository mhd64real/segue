import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { runAuthCallback, type CallbackPorts } from "@/lib/auth/callback";
import { NEXT_PATH_COOKIE } from "@/lib/auth/next-path";
import { AUTH_CALLBACK_PATH, DEFAULT_NEXT_PATH, loginPath } from "@/lib/auth/routes";
import { checkGmailScopes } from "@/lib/auth/scopes";
import { encryptSecret } from "@/lib/crypto";
import { isDemoMode } from "@/lib/demo/guard";
import { resolveOwnerFromClaims } from "@/lib/owner";
import { createAdminClientOrNull } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function ports(supabase: SupabaseClient): CallbackPorts {
  return {
    async exchangeCode(code) {
      // auth-js writes the session only after a successful exchange, so an error result (a
      // refused code, or no stored verifier) leaves the browser's cookies as they were.
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error || !data.session) {
        return "not_exchanged";
      }
      const { access_token, refresh_token, provider_token, provider_refresh_token } = data.session;
      // Identity comes from claims verified on the new access token.
      const verified = await supabase.auth.getClaims(access_token);
      if (verified.error || !verified.data) {
        return "unverified";
      }
      // The exchange saved the whole session, Google tokens included, into the auth cookie,
      // which page scripts can read. Saving it again from the Supabase tokens alone rewrites
      // that cookie without them. On a failed rewrite the callback signs out, which removes it.
      const rewritten = await supabase.auth.setSession({ access_token, refresh_token });
      if (rewritten.error || !rewritten.data.session) {
        return "unverified";
      }
      const { claims } = verified.data;
      return {
        userId: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        amr: claims.amr,
        providerToken: provider_token ?? null,
        providerRefreshToken: provider_refresh_token ?? null,
      };
    },
    resolveAccess: (session) => resolveOwnerFromClaims({ email: session.email ?? undefined, amr: session.amr }),
    checkScopes: (providerToken) => checkGmailScopes(providerToken),
    async signOut(scope) {
      await supabase.auth.signOut({ scope });
    },
    async deleteUser(userId) {
      const admin = createAdminClientOrNull();
      if (!admin) {
        return false;
      }
      const { error } = await admin.auth.admin.deleteUser(userId);
      return !error;
    },
    encrypt: encryptSecret,
  };
}

function redirectTo(request: NextRequest, location: string): NextResponse {
  let target = new URL(location, request.url);
  if (target.origin !== request.nextUrl.origin) {
    target = new URL(DEFAULT_NEXT_PATH, request.url);
  }
  const response = NextResponse.redirect(target, 303);
  // An epoch expiry, unlike Max-Age=0, survives Next merging this with the session cookie writes.
  response.cookies.delete({ name: NEXT_PATH_COOKIE, path: AUTH_CALLBACK_PATH });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: NextRequest) {
  if (isDemoMode()) {
    return redirectTo(request, DEFAULT_NEXT_PATH);
  }
  let supabase: SupabaseClient | null = null;
  try {
    supabase = await createClient();
  } catch {
    supabase = null;
  }
  if (!supabase) {
    return redirectTo(request, loginPath({ error: "not_configured" }));
  }
  const { searchParams } = request.nextUrl;
  const location = await runAuthCallback(
    {
      code: searchParams.get("code"),
      providerError: searchParams.has("error") || searchParams.has("error_code"),
      nextPath: request.cookies.get(NEXT_PATH_COOKIE)?.value ?? null,
    },
    ports(supabase),
  );
  return redirectTo(request, location);
}
