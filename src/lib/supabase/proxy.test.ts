import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: { name: string; value: string; options: object }[], headers: Record<string, string>) => void;
};

const getClaims = vi.fn();
const createServerClient = vi.fn<(url: string, key: string, options: { cookies: CookieMethods }) => unknown>(() => ({
  auth: { getClaims },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: { cookies: CookieMethods }) =>
    createServerClient(url, key, options),
}));

const { updateSession } = await import("@/lib/supabase/proxy");

function request(cookie?: string) {
  return new NextRequest("https://segue.example/videos", {
    headers: cookie ? { cookie } : undefined,
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
}

describe("updateSession", () => {
  it("passes the request through without env", async () => {
    const result = await updateSession(request());
    expect(result.configured).toBe(false);
    expect(result.claims).toBeNull();
    expect(result.response.headers.get("x-middleware-next")).toBe("1");
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("returns verified claims", async () => {
    configure();
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: "user-1", email: "owner@example.com" } }, error: null });
    const result = await updateSession(request("sb-auth=abc"));
    expect(result.configured).toBe(true);
    expect(result.claims).toMatchObject({ sub: "user-1", email: "owner@example.com" });
    const options = createServerClient.mock.calls[0][2];
    expect(options.cookies.getAll()).toEqual([{ name: "sb-auth", value: "abc" }]);
  });

  it("treats a claims error, no session or a thrown error as signed out", async () => {
    configure();
    getClaims.mockResolvedValueOnce({ data: null, error: new Error("invalid JWT") });
    expect((await updateSession(request())).claims).toBeNull();
    getClaims.mockResolvedValueOnce({ data: null, error: null });
    expect((await updateSession(request())).claims).toBeNull();
    getClaims.mockRejectedValueOnce(new Error("network"));
    const result = await updateSession(request());
    expect(result.claims).toBeNull();
    expect(result.configured).toBe(true);
  });

  it("copies refreshed cookies and cache headers onto the returned response", async () => {
    configure();
    getClaims.mockImplementationOnce(async () => {
      const options = createServerClient.mock.calls[0][2];
      options.cookies.setAll([{ name: "sb-auth", value: "refreshed", options: { path: "/", httpOnly: true } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        Expires: "0",
      });
      return { data: { claims: { sub: "user-1" } }, error: null };
    });
    const req = request("sb-auth=old");
    const result = await updateSession(req);
    expect(req.cookies.get("sb-auth")?.value).toBe("refreshed");
    expect(result.response.cookies.get("sb-auth")?.value).toBe("refreshed");
    expect(result.response.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
    expect(result.response.headers.get("expires")).toBe("0");
    expect(result.claims).toMatchObject({ sub: "user-1" });
  });
});
