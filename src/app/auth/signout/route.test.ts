import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const signOut = vi.fn(async () => ({ error: null }));
  return { signOut, createClient: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

const { POST } = await import("@/app/auth/signout/route");

const ORIGIN = "https://segue.example";

function request(headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/auth/signout`, { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SEGUE_DEMO", undefined);
  mocks.createClient.mockResolvedValue({ auth: { signOut: mocks.signOut } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /auth/signout", () => {
  it("signs out this session and redirects to the sign-in screen", async () => {
    const response = await POST(request({ origin: ORIGIN, cookie: "sb-ref-auth-token.0=a; sb-ref-auth-token.1=b; other=x" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.cookies.get("sb-ref-auth-token.0")).toMatchObject({ value: "", expires: new Date(0) });
    expect(response.cookies.get("sb-ref-auth-token.1")).toMatchObject({ value: "", expires: new Date(0) });
    expect(response.cookies.get("other")).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses posts from another site", async () => {
    const response = await POST(request({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("redirects without env", async () => {
    mocks.createClient.mockResolvedValueOnce(null);
    const response = await POST(request());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("clears the cookies even when Supabase cannot be reached", async () => {
    mocks.signOut.mockRejectedValueOnce(new Error("network"));
    const response = await POST(request({ cookie: "sb-ref-auth-token=a" }));
    expect(response.status).toBe(303);
    expect(response.cookies.get("sb-ref-auth-token")).toMatchObject({ value: "", expires: new Date(0) });
  });

  it("does not touch Supabase in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    const response = await POST(request({ origin: ORIGIN }));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
