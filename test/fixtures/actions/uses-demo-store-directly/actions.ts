"use server";

import { getDemoStore } from "@/lib/demo/store";

// Fixture: skips the owner check and uses the demo store. The security test must report it.

export async function listVideos() {
  const store = await getDemoStore();
  return store.listVideos();
}
