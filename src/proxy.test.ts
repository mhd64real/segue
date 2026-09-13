import { NextRequest, NextResponse } from "next/server";
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@/lib/supabase/proxy";

const updateSession = vi.hoisted(() => vi.fn<(request: NextRequest) => Promise<SessionUpdate>>());

vi.mock("@/lib/supabase/proxy", () => ({ updateSession }));

const { config, proxy } = await import("@/proxy");

const ORIGIN = "https://segue.example";

function request(path: string, init: { method?: string; cookie?: string } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: init.cookie ? { cookie: init.cookie } : undefined,
  });
}

function session(req: NextRequest, overrides: Partial<SessionUpdate> = {}): SessionUpdate {
  return { response: NextResponse.next({ request: req }), claims: null, configured: true, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SEGUE_DEMO", undefined);
  vi.stubEnv("NODE_ENV", "test");
  updateSession.mockImplementation(async (req) => session(req));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it("runs on pages, auth routes and other API routes", () => {
    for (const url of [
      "/",
      "/videos",
      "/videos/123/branches/456",
      "/sponsorships?status=failed",
      "/emails",
      "/login",
      "/auth/callback",
      "/auth/signout",
      "/api/other",
      "/api/cronjobs",
      "/api/gmail/pushes",
    ]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it("skips Next internals, static files and the favicon", () => {
    for (const url of [
      "/_next/static/chunks/main.js",
      "/_next/image?url=%2Fa.png&w=64&q=75",
      "/_next/webpack-hmr",
      "/favicon.ico",
      "/logo.svg",
      "/images/cover.png",
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
    ]) {
      expect(matches(url), url).toBe(false);
    }
  });

  it("skips the Gmail push webhook and the cron routes, which authenticate themselves", () => {
    for (const url of ["/api/gmail/push", "/api/gmail/push/", "/api/cron", "/api/cron/daily"]) {
      expect(matches(url), url).toBe(false);
    }
  });
});

describe("proxy", () => {
  it("passes requests through without Supabase env", async () => {
    updateSession.mockImplementationOnce(async (req) => session(req, { configured: false }));
    const response = await proxy(request("/videos"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getRedirectUrl(response)).toBeNull();
  });

  it("does not require or refresh a session in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    const response = await proxy(request("/videos"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("still requires a session when the demo flag is set outside development", async () => {
    vi.stubEnv("SEGUE_DEMO", "1");
    const response = await proxy(request("/videos"));
    expect(updateSession).toHaveBeenCalled();
    expect(getRedirectUrl(response)).toBe(`${ORIGIN}/login`);
  });

  it("redirects signed-out page requests to /login and remembers the page", async () => {
    expect(getRedirectUrl(await proxy(request("/videos")))).toBe(`${ORIGIN}/login`);
    expect(getRedirectUrl(await proxy(request("/")))).toBe(`${ORIGIN}/login`);
    expect(getRedirectUrl(await proxy(request("/emails?tab=sent")))).toBe(
      `${ORIGIN}/login?next=%2Femails%3Ftab%3Dsent`,
    );
    const head = await proxy(request("/sponsorships", { method: "HEAD" }));
    expect(getRedirectUrl(head)).toBe(`${ORIGIN}/login?next=%2Fsponsorships`);
    expect(head.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps /login and /auth routes reachable without a session", async () => {
    for (const path of ["/login", "/login?error=not_allowed", "/auth/callback?code=abc", "/auth/signout"]) {
      const response = await proxy(request(path));
      expect(getRedirectUrl(response), path).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("does not redirect Server Action posts or API routes, which fail closed themselves", async () => {
    for (const [path, method] of [
      ["/videos", "POST"],
      ["/api/other", "GET"],
      ["/api", "GET"],
    ]) {
      const response = await proxy(request(path, { method }));
      expect(getRedirectUrl(response), `${method} ${path}`).toBeNull();
    }
  });

  it("lets a signed-in request through with its refreshed cookies", async () => {
    updateSession.mockImplementationOnce(async (req) => {
      const response = NextResponse.next({ request: req });
      response.cookies.set("sb-auth", "refreshed", { path: "/", httpOnly: true });
      return session(req, { response, claims: { sub: "user-1" } as SessionUpdate["claims"] });
    });
    const response = await proxy(request("/videos", { cookie: "sb-auth=old" }));
    expect(getRedirectUrl(response)).toBeNull();
    expect(response.cookies.get("sb-auth")?.value).toBe("refreshed");
  });

  it("copies cookie changes onto the redirect", async () => {
    updateSession.mockImplementationOnce(async (req) => {
      const response = NextResponse.next({ request: req });
      response.cookies.set("sb-auth", "", { path: "/", maxAge: 0 });
      return session(req, { response });
    });
    const response = await proxy(request("/videos", { cookie: "sb-auth=expired" }));
    expect(getRedirectUrl(response)).toBe(`${ORIGIN}/login`);
    expect(response.cookies.get("sb-auth")).toMatchObject({ value: "", maxAge: 0, path: "/" });
  });
});
