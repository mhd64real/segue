import { ownerStoreForAction } from "@/lib/owner";

// Fixture: checks the owner but lacks the "use server" directive, so it is not a Server
// Action module at all. The security test must report it.

export async function renameVideo() {
  return ownerStoreForAction();
}
