"use server";

import { createSupabaseStore } from "@/lib/store/supabase";
import { createAdminClient } from "@/lib/supabase/admin";

// Fixture: skips the owner check and reads the database directly. The security test
// must report it.

export async function listVideos() {
  return createSupabaseStore(createAdminClient()).listVideos();
}
