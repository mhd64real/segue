"use server";

// Fixture: skips the owner check and calls an external service. The security test must
// report it.

export async function listVideos() {
  const response = await fetch("https://example.supabase.co/rest/v1/videos");
  return response.ok;
}
