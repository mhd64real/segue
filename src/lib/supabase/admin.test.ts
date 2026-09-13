import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingEnvError } from "@/lib/env";
import { createAdminClient, createAdminClientOrNull } from "@/lib/supabase/admin";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
  vi.stubEnv("SUPABASE_SECRET_KEY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin client", () => {
  it("fails closed without env", () => {
    expect(createAdminClientOrNull()).toBeNull();
    expect(() => createAdminClient()).toThrow(MissingEnvError);
  });

  it("is not created from the publishable key alone", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    expect(createAdminClientOrNull()).toBeNull();
    expect(() => createAdminClient()).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("builds one client per URL and key without a persisted session", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_one");
    const first = createAdminClient();
    expect(createAdminClientOrNull()).toBe(first);
    const { data } = await first.auth.getSession();
    expect(data.session).toBeNull();

    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_two");
    expect(createAdminClient()).not.toBe(first);
  });
});
