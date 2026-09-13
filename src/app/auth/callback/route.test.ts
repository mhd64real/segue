import { randomBytes } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_TOKENINFO_URL } from "@/lib/auth/scopes";
import { decryptSecret } from "@/lib/crypto";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getClaims: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  deleteUser: vi.fn(async () => ({ data: { user: null }, error: null })),
  createClient: vi.fn(),
  createAdminClientOrNull: vi.fn(),
  store: { current: null as Store | null },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClientOrNull: mocks.createAdminClientOrNull }));
vi.mock("@/lib/store/supabase", () => ({ createSupabaseStore: () => mocks.store.current }));

const { GET } = await import("@/app/auth/callback/route");

const ORIGIN = "https://segue.example";
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  ALLOWED_EMAIL: "owner@example.com",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

const tokenInfo = vi.fn<typeof fetch>();

function request(query: string, cookie?: string) {
  return new NextRequest(`${ORIGIN}/auth/callback${query}`, { headers: cookie ? { cookie } : undefined });
}

const GOOGLE_AMR = [{ method: "oauth", timestamp: 1_700_000_000 }];

function signIn(email: string, session: Record<string, unknown> = {}, amr: unknown = GOOGLE_AMR) {
  mocks.exchangeCodeForSession.mockResolvedValue({
    data: {
      session: {
        access_token: "access-jwt",
        refresh_token: "supabase-refresh",
        provider_token: "ya29.provider",
        provider_refresh_token: "1//refresh",
        ...session,
      },
      user: { id: "user-1" },
    },
    error: null,
  });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", email, amr } }, error: null });
  mocks.setSession.mockResolvedValue({
    data: { session: { access_token: "access-jwt", refresh_token: "supabase-refresh" }, user: { id: "user-1" } },
    error: null,
  });
}

function grantScopes(scope: string) {
  tokenInfo.mockImplementation(async () => new Response(JSON.stringify({ scope }), { status: 200 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SEGUE_DEMO", undefined);
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", tokenInfo);
  mocks.store.current = createMemoryStore();
  mocks.createClient.mockImplementation(async () =>
    process.env.NEXT_PUBLIC_SUPABASE_URL
      ? {
          auth: {
            exchangeCodeForSession: mocks.exchangeCodeForSession,
            getClaims: mocks.getClaims,
            setSession: mocks.setSession,
            signOut: mocks.signOut,
          },
        }
      : null,
  );
  mocks.createAdminClientOrNull.mockImplementation(() =>
    process.env.SUPABASE_SECRET_KEY ? { auth: { admin: { deleteUser: mocks.deleteUser } } } : null,
  );
  signIn("Owner@Example.com");
  grantScopes(`openid ${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /auth/callback", () => {
  it("connects the owner's Google account and redirects to /videos", async () => {
    await mocks.store.current?.updateAppState({ needsReauth: true });
    const response = await GET(request("?code=abc"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/videos`);
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(mocks.getClaims).toHaveBeenCalledWith("access-jwt");
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: "access-jwt", refresh_token: "supabase-refresh" });
    expect(tokenInfo.mock.calls[0][0]).toBe(GOOGLE_TOKENINFO_URL);
    const state = await mocks.store.current!.getAppState();
    expect(state.googleEmail).toBe("owner@example.com");
    expect(state.needsReauth).toBe(false);
    expect(state.refreshTokenEnc).not.toContain("1//refresh");
    expect(decryptSecret(state.refreshTokenEnc!)).toBe("1//refresh");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(response.cookies.get("segue_next")).toMatchObject({ value: "", expires: new Date(0), path: "/auth/callback" });
  });

  it("returns to the remembered page from the next cookie", async () => {
    const response = await GET(request("?code=abc", "segue_next=%2Femails%3Ftab%3Dsent"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/emails?tab=sent`);
  });

  it("ignores an unsafe next cookie", async () => {
    for (const value of ["https%3A%2F%2Fevil.example", "%2F%2Fevil.example", "%2F..%2F%2Fevil.example"]) {
      const response = await GET(request("?code=abc", `segue_next=${value}`));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/videos`);
    }
  });

  it("refuses another account: signs it out everywhere, deletes it and saves nothing", async () => {
    signIn("someone@example.com");
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_allowed`);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(mocks.deleteUser).toHaveBeenCalledWith("user-1");
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteUser.mock.invocationCallOrder[0]);
    expect(tokenInfo).not.toHaveBeenCalled();
    expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("refuses a session for the allowed email that did not come from a Google sign-in", async () => {
    for (const amr of [[{ method: "magiclink", timestamp: 1_700_000_000 }], ["password"], []]) {
      vi.clearAllMocks();
      signIn("owner@example.com", {}, amr);
      const response = await GET(request("?code=abc"));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_allowed`);
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
      expect(mocks.deleteUser).toHaveBeenCalledWith("user-1");
      expect(tokenInfo).not.toHaveBeenCalled();
      expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
    }
  });

  it("keeps the page to return to when sign in fails", async () => {
    grantScopes(`openid ${GMAIL_READONLY_SCOPE}`);
    const response = await GET(request("?code=abc", "segue_next=%2Femails%3Ftab%3Dsent"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=missing_permissions&next=%2Femails%3Ftab%3Dsent`);
    expect(response.cookies.get("segue_next")).toMatchObject({ value: "", expires: new Date(0) });
    const cancelled = await GET(request("?error=access_denied", "segue_next=%2Fsponsorships"));
    expect(cancelled.headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed&next=%2Fsponsorships`);
  });

  it("does not delete the account when the admin env is missing, but still refuses it", async () => {
    signIn("someone@example.com");
    vi.stubEnv("SUPABASE_SECRET_KEY", undefined);
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_allowed`);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("reports missing permissions when Gmail send was unticked", async () => {
    grantScopes(`openid ${GMAIL_READONLY_SCOPE}`);
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=missing_permissions`);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("reports a missing refresh token", async () => {
    signIn("owner@example.com", { provider_refresh_token: null });
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=no_refresh_token`);
  });

  it("reports sign in failed without signing out when the code is refused", async () => {
    mocks.exchangeCodeForSession.mockResolvedValueOnce({ data: { session: null, user: null }, error: new Error("bad code") });
    expect((await GET(request("?code=abc"))).headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    expect(mocks.getClaims).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("reports sign in failed and signs out when the claims check fails", async () => {
    mocks.getClaims.mockResolvedValueOnce({ data: null, error: new Error("invalid JWT") });
    expect((await GET(request("?code=abc"))).headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("signs out and saves nothing when the session cookie cannot be rewritten without the Google tokens", async () => {
    mocks.setSession.mockResolvedValueOnce({ data: { session: null, user: null }, error: new Error("network") });
    expect((await GET(request("?code=abc"))).headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    mocks.setSession.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await GET(request("?code=abc"))).headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(tokenInfo).not.toHaveBeenCalled();
    expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("reports sign in failed for a provider error or a missing code, without exchanging", async () => {
    for (const query of ["?error=access_denied&error_description=denied", "", "?code="]) {
      const response = await GET(request(query));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    }
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports not configured without the encryption key", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", undefined);
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_configured`);
    expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("redirects to the setup state with no env and touches nothing", async () => {
    for (const name of Object.keys(ENV)) {
      vi.stubEnv(name, undefined);
    }
    const response = await GET(request("?code=abc"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_configured`);
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(tokenInfo).not.toHaveBeenCalled();
  });

  it("goes straight to the dashboard in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    const response = await GET(request("?code=abc"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/videos`);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

// The same route with the real @supabase/ssr client, so the auth cookie it writes can be read
// back. Only Supabase Auth and Google are faked, at the network level.
describe("GET /auth/callback session cookie", () => {
  type CookieJar = NextResponse["cookies"];

  const AUTH_COOKIE = "sb-example-auth-token";
  // Long enough that a session holding it needs more than one cookie chunk.
  const PROVIDER_TOKEN = `ya29.${"p".repeat(4000)}`;
  const PROVIDER_REFRESH_TOKEN = "1//google-refresh-token";
  const USER_CLAIMS = { sub: "user-1", email: "owner@example.com", aud: "authenticated" };

  function base64url(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  function accessToken(amr: unknown): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...USER_CLAIMS, amr, role: "authenticated", iat: now, exp: now + 3600 };
    return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}.c2lnbmF0dXJl`;
  }

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  const USER = { id: "user-1", aud: "authenticated", email: "owner@example.com", app_metadata: {}, user_metadata: {} };

  // Answers like Supabase Auth and Google. `override` runs first and can answer a request itself
  // (or throw, like a failed fetch); returning undefined leaves the request to the default answer.
  function fakeNetwork(amr: unknown, override?: (url: URL) => Response | undefined) {
    const user = USER;
    const token = accessToken(amr);
    return vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const answer = override?.(url);
      if (answer) {
        return answer;
      }
      if (url.href === GOOGLE_TOKENINFO_URL) {
        return json({ scope: `openid ${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}` });
      }
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
        return json({
          access_token: token,
          refresh_token: "supabase-refresh",
          token_type: "bearer",
          expires_in: 3600,
          user,
          provider_token: PROVIDER_TOKEN,
          provider_refresh_token: PROVIDER_REFRESH_TOKEN,
        });
      }
      if (url.pathname === "/auth/v1/user") {
        return json(user);
      }
      if (url.pathname === "/auth/v1/logout") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
  }

  // Stands in for cookies() in a Route Handler: the request cookies, overlaid with every write.
  function useRealClient(network: typeof fetch, req: NextRequest): CookieJar {
    const jar = new NextResponse(null).cookies;
    for (const { name, value } of req.cookies.getAll()) {
      jar.set(name, value);
    }
    mocks.createClient.mockImplementation(async () =>
      createServerClient(ENV.NEXT_PUBLIC_SUPABASE_URL, ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
        global: { fetch: network },
        cookies: {
          getAll: () => jar.getAll(),
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              jar.set(name, value, options);
            }
          },
        },
      }),
    );
    return jar;
  }

  // What the browser keeps: Supabase auth cookies that still hold a value.
  function liveAuthCookies(jar: CookieJar) {
    return jar.getAll().filter((cookie) => cookie.name.startsWith(AUTH_COOKIE) && cookie.value !== "");
  }

  function decodeSession(value: string): Record<string, unknown> {
    expect(value.startsWith("base64-")).toBe(true);
    return JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"));
  }

  function signInRequest() {
    return request("?code=abc", `${AUTH_COOKIE}-code-verifier=base64-${base64url("verifier-1")}`);
  }

  it("leaves a session cookie without the Google tokens after a successful sign in", async () => {
    const network = fakeNetwork(GOOGLE_AMR);
    vi.stubGlobal("fetch", network);
    const req = signInRequest();
    const jar = useRealClient(network, req);

    const response = await GET(req);

    expect(response.headers.get("location")).toBe(`${ORIGIN}/videos`);
    expect(decryptSecret((await mocks.store.current!.getAppState()).refreshTokenEnc!)).toBe(PROVIDER_REFRESH_TOKEN);
    const live = liveAuthCookies(jar);
    // One unchunked cookie: the chunks written with the Google tokens were cleared.
    expect(live.map((cookie) => cookie.name)).toEqual([AUTH_COOKIE]);
    const session = decodeSession(live[0].value);
    expect(session).toMatchObject({ refresh_token: "supabase-refresh" });
    expect(session).not.toHaveProperty("provider_token");
    expect(session).not.toHaveProperty("provider_refresh_token");
    for (const cookie of [...jar.getAll(), ...response.cookies.getAll()]) {
      expect(cookie.value).not.toContain(PROVIDER_REFRESH_TOKEN);
    }
  });

  function requestedPaths(network: ReturnType<typeof fakeNetwork>): string[] {
    return network.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname);
  }

  it("removes the session cookie holding the Google tokens when the rewrite fails, even if revoking fails", async () => {
    let userCalls = 0;
    const network = fakeNetwork(GOOGLE_AMR, (url) => {
      if (url.pathname === "/auth/v1/user") {
        userCalls += 1;
        // The first /user call verifies the claims; the second is the rewrite.
        return userCalls === 2 ? new Response(null, { status: 500 }) : undefined;
      }
      if (url.pathname === "/auth/v1/logout") {
        throw new TypeError("fetch failed");
      }
      return undefined;
    });
    vi.stubGlobal("fetch", network);
    const req = signInRequest();
    const jar = useRealClient(network, req);

    const response = await GET(req);

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    expect(userCalls).toBe(2);
    expect(requestedPaths(network)).toContain("/auth/v1/logout");
    expect(liveAuthCookies(jar)).toEqual([]);
    for (const cookie of [...jar.getAll(), ...response.cookies.getAll()]) {
      expect(cookie.value).not.toContain(PROVIDER_REFRESH_TOKEN);
    }
    expect((await mocks.store.current!.getAppState()).refreshTokenEnc).toBeNull();
  });

  // A link from any site can carry a code. Without a stored verifier (the usual case) auth-js
  // fails before any request; with one from a sign in started in another tab, Supabase refuses it.
  it.for([
    { verifier: "no stored verifier", withVerifier: false, requested: [] },
    { verifier: "a verifier from another sign in", withVerifier: true, requested: ["/auth/v1/token"] },
  ])("keeps the owner's existing session when a link carries a code that cannot be exchanged ($verifier)", async ({
    withVerifier,
    requested,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    const existing = `base64-${base64url({
      access_token: accessToken(GOOGLE_AMR),
      refresh_token: "owner-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user: USER,
    })}`;
    const verifierCookie = `${AUTH_COOKIE}-code-verifier=base64-${base64url("verifier-1")}`;
    const network = fakeNetwork(GOOGLE_AMR, (url) =>
      url.pathname === "/auth/v1/token"
        ? new Response(JSON.stringify({ code: 404, error_code: "flow_state_not_found", msg: "invalid flow state" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    vi.stubGlobal("fetch", network);
    const req = request("?code=bogus", `${AUTH_COOKIE}=${existing}${withVerifier ? `; ${verifierCookie}` : ""}`);
    const jar = useRealClient(network, req);

    const response = await GET(req);

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=sign_in_failed`);
    // No /logout request: the session is not revoked.
    expect(requestedPaths(network)).toEqual(requested);
    const sessionCookies = liveAuthCookies(jar).filter(({ name }) => !name.endsWith("-code-verifier"));
    expect(sessionCookies.map(({ name, value }) => ({ name, value }))).toEqual([{ name: AUTH_COOKIE, value: existing }]);
    expect(response.cookies.getAll().filter(({ name }) => name.startsWith(AUTH_COOKIE))).toEqual([]);
  });

  it("leaves no session cookie when the account is refused", async () => {
    const network = fakeNetwork([{ method: "password", timestamp: 1_700_000_000 }]);
    vi.stubGlobal("fetch", network);
    const req = signInRequest();
    const jar = useRealClient(network, req);

    const response = await GET(req);

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=not_allowed`);
    expect(liveAuthCookies(jar)).toEqual([]);
  });
});
