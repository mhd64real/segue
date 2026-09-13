import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/client";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser client", () => {
  it("returns null without env", () => {
    expect(createClient()).toBeNull();
  });

  it("returns null when the URL is invalid", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a url");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    expect(createClient()).toBeNull();
  });

  it("creates an auth client with env", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    const client = createClient();
    expect(client).not.toBeNull();
    expect(typeof client?.auth.signInWithOAuth).toBe("function");
  });
});
