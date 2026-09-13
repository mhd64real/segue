import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "@/lib/env";

// Browser client for auth only. The browser never reads the database (no grants).
// Returns null when Supabase is not configured.
export function createClient(): SupabaseClient | null {
  const env = readEnv("supabasePublic");
  if (!env) {
    return null;
  }
  return createBrowserClient(env.url, env.publishableKey);
}
