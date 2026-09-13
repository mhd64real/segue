"use server";

import { ownerStoreForAction } from "@/lib/owner";

// Fixture: answers before checking the owner, so an anonymous caller learns something.
// The security test must report it.

export async function renameVideo(title?: string) {
  if (!title) {
    return { ok: false as const, error: "Title is required" };
  }
  const owner = await ownerStoreForAction();
  return owner;
}
