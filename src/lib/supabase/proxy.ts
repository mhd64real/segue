import { createServerClient } from "@supabase/ssr";
import type { JwtPayload } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { readEnv } from "@/lib/env";

export interface SessionUpdate {
  // The response to return (or to copy cookies and headers from). It carries any
  // refreshed session cookies and the no-cache headers that come with them.
  response: NextResponse;
  // Verified JWT claims, or null when signed out or when verification failed.
  claims: JwtPayload | null;
  // False when Supabase env is missing; the request is then passed through untouched.
  configured: boolean;
}

// Refreshes the Supabase session for a proxy request. Used by src/proxy.ts.
export async function updateSession(request: NextRequest): Promise<SessionUpdate> {
  let response = NextResponse.next({ request });
  const env = readEnv("supabasePublic");
  if (!env) {
    return { response, claims: null, configured: false };
  }

  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Nothing may run between creating the client and getClaims().
  let claims: JwtPayload | null = null;
  try {
    const { data, error } = await supabase.auth.getClaims();
    claims = error || !data ? null : data.claims;
  } catch {
    claims = null;
  }
  return { response, claims, configured: true };
}
