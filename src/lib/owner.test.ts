import type { JwtPayload } from "@supabase/supabase-js";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const getClaims = vi.fn();
  return {
    getClaims,
    supabaseClient: { auth: { getClaims } },
    createClient: vi.fn(),
    adminClient: { kind: "admin" },
    createAdminClientOrNull: vi.fn(),
    supabaseStore: { kind: "supabase-store" },
    createSupabaseStore: vi.fn(),
    demoStore: { kind: "demo-store" },
    getDemoStore: vi.fn(),
    connection: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClientOrNull: mocks.createAdminClientOrNull }));
vi.mock("@/lib/store/supabase", () => ({ createSupabaseStore: mocks.createSupabaseStore }));
vi.mock("@/lib/demo/store", () => ({ DEMO_OWNER_EMAIL: "demo@example.com", getDemoStore: mocks.getDemoStore }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: mocks.connection,
}));

const {
  isUnauthorized,
  normalizeEmail,
  ownerStore,
  ownerStoreForAction,
  resolveOwner,
  resolveOwnerFromClaims,
  unauthorized,
} = await import("@/lib/owner");

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  ALLOWED_EMAIL: "owner@example.com",
};

function configure(overrides: Partial<Record<keyof typeof ENV, string | undefined>> = {}) {
  for (const [name, value] of Object.entries({ ...ENV, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

const GOOGLE_AMR = [{ method: "oauth", timestamp: 1_700_000_000 }];

// Verified claims of a Google sign-in.
function google(email: string): Pick<JwtPayload, "email" | "amr"> {
  return { email, amr: GOOGLE_AMR };
}

function signedInAs(email: unknown, amr: unknown = GOOGLE_AMR) {
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", email, amr } }, error: null });
}

async function redirectTarget(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected a redirect");
    },
    (reason: unknown) => reason,
  );
  if (!isRedirectError(error)) {
    throw error;
  }
  return getURLFromRedirectError(error);
}

function expectNoStoreTouched() {
  expect(mocks.createAdminClientOrNull).not.toHaveBeenCalled();
  expect(mocks.createSupabaseStore).not.toHaveBeenCalled();
  expect(mocks.getDemoStore).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [...Object.keys(ENV), "SEGUE_DEMO"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("NODE_ENV", "test");
  mocks.createClient.mockImplementation(async () =>
    process.env.NEXT_PUBLIC_SUPABASE_URL ? mocks.supabaseClient : null,
  );
  mocks.createAdminClientOrNull.mockImplementation(() => (process.env.SUPABASE_SECRET_KEY ? mocks.adminClient : null));
  mocks.createSupabaseStore.mockReturnValue(mocks.supabaseStore);
  mocks.getDemoStore.mockResolvedValue(mocks.demoStore);
  mocks.getClaims.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Owner@Example.COM \n")).toBe("owner@example.com");
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe("resolveOwner", () => {
  it("returns the Supabase store for the allowed email, matched without case or spaces", async () => {
    configure({ ALLOWED_EMAIL: "  Owner@Example.com " });
    signedInAs("OWNER@example.COM");
    const resolution = await resolveOwner();
    expect(resolution).toEqual({
      status: "owner",
      owner: { email: "owner@example.com", store: mocks.supabaseStore, demo: false },
    });
    expect(mocks.createSupabaseStore).toHaveBeenCalledWith(mocks.adminClient);
    expect(mocks.getDemoStore).not.toHaveBeenCalled();
  });

  it("is signed out without a session", async () => {
    configure();
    expect(await resolveOwner()).toEqual({ status: "signed_out" });
    expectNoStoreTouched();
  });

  it("is signed out when claims fail verification or the check throws", async () => {
    configure();
    mocks.getClaims.mockResolvedValueOnce({ data: null, error: new Error("invalid JWT") });
    expect(await resolveOwner()).toEqual({ status: "signed_out" });
    mocks.getClaims.mockRejectedValueOnce(new Error("network"));
    expect(await resolveOwner()).toEqual({ status: "signed_out" });
    mocks.createClient.mockRejectedValueOnce(new Error("cookies unavailable"));
    expect(await resolveOwner()).toEqual({ status: "signed_out" });
    expectNoStoreTouched();
  });

  it("is not allowed for another email, a missing email or a look-alike", async () => {
    configure();
    for (const email of ["someone@example.com", undefined, null, "", 7, "owner@example.com.evil.example", "xowner@example.com"]) {
      signedInAs(email);
      expect(await resolveOwner()).toEqual({ status: "not_allowed" });
    }
    expectNoStoreTouched();
  });

  it("is not allowed for a password, OTP or magic link session with the allowed email", async () => {
    configure();
    for (const method of ["password", "otp", "magiclink"]) {
      signedInAs("owner@example.com", [{ method, timestamp: 1_700_000_000 }]);
      expect(await resolveOwner()).toEqual({ status: "not_allowed" });
    }
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1", email: "owner@example.com" } }, error: null });
    expect(await resolveOwner()).toEqual({ status: "not_allowed" });
    expectNoStoreTouched();
  });

  it("is not configured when any required env group is missing, without reading cookies", async () => {
    for (const missing of Object.keys(ENV) as (keyof typeof ENV)[]) {
      vi.clearAllMocks();
      configure({ [missing]: undefined });
      signedInAs("owner@example.com");
      expect(await resolveOwner()).toEqual({ status: "not_configured" });
      expect(mocks.createClient).not.toHaveBeenCalled();
      expectNoStoreTouched();
    }
  });

  it("is not configured with no env at all", async () => {
    expect(await resolveOwner()).toEqual({ status: "not_configured" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expectNoStoreTouched();
  });

  it("is not configured when ALLOWED_EMAIL or the Supabase URL is invalid", async () => {
    configure({ ALLOWED_EMAIL: "not-an-email" });
    signedInAs("not-an-email");
    expect(await resolveOwner()).toEqual({ status: "not_configured" });
    configure({ NEXT_PUBLIC_SUPABASE_URL: "not a url" });
    expect(await resolveOwner()).toEqual({ status: "not_configured" });
    expectNoStoreTouched();
  });

  it("returns the demo store and demo owner in demo mode without touching Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    expect(await resolveOwner()).toEqual({
      status: "owner",
      owner: { email: "demo@example.com", store: mocks.demoStore, demo: true },
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClientOrNull).not.toHaveBeenCalled();
    expect(mocks.createSupabaseStore).not.toHaveBeenCalled();
  });

  it("ignores the demo flag outside development", async () => {
    vi.stubEnv("SEGUE_DEMO", "1");
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(await resolveOwner()).toEqual({ status: "not_configured" });
      configure();
      expect(await resolveOwner()).toEqual({ status: "signed_out" });
      for (const name of Object.keys(ENV)) {
        vi.stubEnv(name, undefined);
      }
    }
    expectNoStoreTouched();
  });

  it("fails closed when the demo store cannot be created", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    mocks.getDemoStore.mockRejectedValueOnce(new Error("seed failed"));
    expect(await resolveOwner()).toEqual({ status: "signed_out" });
  });
});

describe("resolveOwnerFromClaims", () => {
  it("checks verified claims without reading the cookie session", () => {
    configure();
    expect(resolveOwnerFromClaims(google("Owner@example.com"))).toMatchObject({ status: "owner" });
    expect(resolveOwnerFromClaims(google("other@example.com"))).toEqual({ status: "not_allowed" });
    expect(resolveOwnerFromClaims(null)).toEqual({ status: "signed_out" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createSupabaseStore).toHaveBeenCalledTimes(1);
  });

  it("accepts a Google sign-in in either amr form, also with a second factor", () => {
    configure();
    for (const amr of [
      ["oauth"],
      [{ method: "oauth", timestamp: 1_700_000_000 }],
      [
        { method: "totp", timestamp: 1_700_000_100 },
        { method: "oauth", timestamp: 1_700_000_000 },
      ],
    ]) {
      expect(resolveOwnerFromClaims({ email: "owner@example.com", amr })).toMatchObject({ status: "owner" });
    }
  });

  it("refuses the allowed email when the session did not come from a Google sign-in", () => {
    configure();
    for (const amr of [
      [{ method: "password", timestamp: 1_700_000_000 }],
      [{ method: "otp", timestamp: 1_700_000_000 }],
      [{ method: "magiclink", timestamp: 1_700_000_000 }],
      [{ method: "email/signup", timestamp: 1_700_000_000 }],
      [{ method: "recovery", timestamp: 1_700_000_000 }],
      [{ method: "oauth_provider/authorization_code", timestamp: 1_700_000_000 }],
      [{ method: "sso/saml", timestamp: 1_700_000_000 }],
      [{ method: "anonymous", timestamp: 1_700_000_000 }],
      ["password"],
      ["otp", "magiclink"],
      [{ method: "OAUTH", timestamp: 1_700_000_000 }],
      [null, 7, {}],
      [],
      undefined,
    ]) {
      expect(resolveOwnerFromClaims({ email: "owner@example.com", amr: amr as JwtPayload["amr"] })).toEqual({
        status: "not_allowed",
      });
    }
    expectNoStoreTouched();
  });

  it("is not configured without env, even for the right email", () => {
    for (const missing of ["SUPABASE_SECRET_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] as const) {
      configure({ [missing]: undefined });
      expect(resolveOwnerFromClaims(google("owner@example.com"))).toEqual({ status: "not_configured" });
    }
    configure({ ALLOWED_EMAIL: undefined });
    expect(resolveOwnerFromClaims(google("owner@example.com"))).toEqual({ status: "not_configured" });
    expectNoStoreTouched();
  });

  it("still names another account or sign-in method not allowed when only the admin env is missing", () => {
    configure({ SUPABASE_SECRET_KEY: undefined });
    expect(resolveOwnerFromClaims(google("someone@example.com"))).toEqual({ status: "not_allowed" });
    expect(resolveOwnerFromClaims({ email: "owner@example.com", amr: ["password"] })).toEqual({ status: "not_allowed" });
    expectNoStoreTouched();
  });
});

describe("ownerStore (pages)", () => {
  it("returns the owner and marks the render dynamic", async () => {
    configure();
    signedInAs("owner@example.com");
    await expect(ownerStore()).resolves.toEqual({ email: "owner@example.com", store: mocks.supabaseStore, demo: false });
    expect(mocks.connection).toHaveBeenCalled();
  });

  it("redirects to the sign-in screen without a session or env", async () => {
    configure();
    expect(await redirectTarget(ownerStore())).toBe("/login");
    for (const name of Object.keys(ENV)) {
      vi.stubEnv(name, undefined);
    }
    expect(await redirectTarget(ownerStore())).toBe("/login");
    expectNoStoreTouched();
  });

  it("redirects with not allowed for another account or a password session with the allowed email", async () => {
    configure();
    signedInAs("someone@example.com");
    expect(await redirectTarget(ownerStore())).toBe("/login?error=not_allowed");
    signedInAs("owner@example.com", [{ method: "password", timestamp: 1_700_000_000 }]);
    expect(await redirectTarget(ownerStore())).toBe("/login?error=not_allowed");
    expectNoStoreTouched();
  });

  it("returns the demo owner in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    await expect(ownerStore()).resolves.toEqual({ email: "demo@example.com", store: mocks.demoStore, demo: true });
  });
});

describe("ownerStoreForAction (actions and routes)", () => {
  it("returns the store for the owner", async () => {
    configure();
    signedInAs("owner@example.com");
    await expect(ownerStoreForAction()).resolves.toEqual({
      ok: true,
      email: "owner@example.com",
      store: mocks.supabaseStore,
      demo: false,
    });
  });

  it("returns the same unauthorized result for every failure, with no details", async () => {
    const expected = { ok: false, error: "unauthorized" };
    expect(await ownerStoreForAction()).toEqual(expected);
    configure();
    expect(await ownerStoreForAction()).toEqual(expected);
    signedInAs("someone@example.com");
    expect(await ownerStoreForAction()).toEqual(expected);
    signedInAs("owner@example.com", ["password"]);
    expect(await ownerStoreForAction()).toEqual(expected);
    mocks.getClaims.mockRejectedValueOnce(new Error("secret detail"));
    const result = await ownerStoreForAction();
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("secret");
    expectNoStoreTouched();
    expect(mocks.connection).not.toHaveBeenCalled();
  });

  it("returns the demo store in demo mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEGUE_DEMO", "1");
    await expect(ownerStoreForAction()).resolves.toEqual({
      ok: true,
      email: "demo@example.com",
      store: mocks.demoStore,
      demo: true,
    });
  });
});

describe("unauthorized", () => {
  it("builds and recognizes the typed result", () => {
    expect(unauthorized()).toEqual({ ok: false, error: "unauthorized" });
    expect(isUnauthorized(unauthorized())).toBe(true);
    expect(isUnauthorized({ ok: false, error: "invalid_input" })).toBe(false);
    expect(isUnauthorized({ ok: true })).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
  });
});
