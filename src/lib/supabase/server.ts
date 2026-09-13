import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { readEnv } from "@/lib/env";

// Cookie-based auth client for Server Components, Server Actions and Route Handlers.
// Create one per request. Returns null when Supabase is not configured.
export async function createClient(): Promise<SupabaseClient | null> {
  const env = readEnv("supabasePublic");
  if (!env) {
    return null;
  }
  const cookieStore = await cookies();
  return createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // The no-cache headers passed as the second argument cannot be set from here;
      // the proxy sets them on the responses where it refreshes the session.
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The proxy refreshes the session.
        }
      },
    },
  });
}
