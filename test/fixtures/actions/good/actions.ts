"use server";

import { ownerStore, ownerStoreForAction } from "@/lib/owner";

// Fixture: actions that check the owner before anything else. The security test expects
// no findings for this module.

export async function renameVideo(id: string, title: string) {
  const owner = await ownerStoreForAction();
  if (!owner.ok) {
    return owner;
  }
  if (typeof id !== "string" || typeof title !== "string") {
    return { ok: false as const, error: "invalid_input" as const };
  }
  const video = await owner.store.updateVideo(id, { title });
  return { ok: true as const, video };
}

export async function deleteVideoAndLeave(id: string) {
  const { store } = await ownerStore();
  await store.deleteVideo(id);
}
