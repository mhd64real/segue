import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = {
  getAll: vi.fn(() => [{ name: "sb-test-auth-token", value: "v" }]),
  set: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

const createServerClient = vi.fn<(...args: unknown[]) => unknown>(() => ({ auth: {} }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClient(...args),
}));

const { cookies } = await import("next/headers");
const { createClient } = await import("@/lib/supabase/server");

type CookieMethods = {
  getAll: () => unknown;
  setAll: (cookies: { name: string; value: string; options: object }[], headers: Record<string, string>) => void;
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server client", () => {
  it("returns null without env and does not touch cookies", async () => {
    expect(await createClient()).toBeNull();
    expect(cookies).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("wires getAll and setAll to the request cookies", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    expect(await createClient()).not.toBeNull();

    const [url, key, options] = createServerClient.mock.calls[0] as [string, string, { cookies: CookieMethods }];
    expect(url).toBe("https://example.supabase.co");
    expect(key).toBe("sb_publishable_x");
    expect(options.cookies.getAll()).toEqual([{ name: "sb-test-auth-token", value: "v" }]);

    options.cookies.setAll([{ name: "a", value: "1", options: { path: "/" } }], {});
    expect(cookieStore.set).toHaveBeenCalledWith("a", "1", { path: "/" });
  });

  it("ignores the cookie write error thrown inside Server Components", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    await createClient();
    const [, , options] = createServerClient.mock.calls[0] as [string, string, { cookies: CookieMethods }];
    cookieStore.set.mockImplementationOnce(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });
    expect(() => options.cookies.setAll([{ name: "a", value: "1", options: {} }], {})).not.toThrow();
  });
});
