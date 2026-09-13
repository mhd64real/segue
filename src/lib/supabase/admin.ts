import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readEnv, requireEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

// Secret key client: bypasses RLS (table grants still apply). Server only, no session.

export type AdminClient = SupabaseClient<Database>;

let cached: { url: string; secretKey: string; client: AdminClient } | null = null;

function build(url: string, secretKey: string): AdminClient {
  if (cached && cached.url === url && cached.secretKey === secretKey) {
    return cached.client;
  }
  const client = createClient<Database>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  cached = { url, secretKey, client };
  return client;
}

// Throws MissingEnvError when the Supabase URL or secret key is not set.
export function createAdminClient(): AdminClient {
  const env = requireEnv("supabaseAdmin");
  return build(env.url, env.secretKey);
}

// Returns null when the Supabase URL or secret key is not set.
export function createAdminClientOrNull(): AdminClient | null {
  const env = readEnv("supabaseAdmin");
  return env ? build(env.url, env.secretKey) : null;
}
