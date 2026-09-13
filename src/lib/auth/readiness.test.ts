import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSignInReadiness, isGoogleProviderEnabled } from "@/lib/auth/readiness";

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  ALLOWED_EMAIL: "owner@example.com",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

function settings(google: unknown, init: ResponseInit = { status: 200 }) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ external: { google, email: true } }), init));
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isGoogleProviderEnabled", () => {
  it("reads the public Auth settings with the publishable key", async () => {
    const fetchImpl = settings(true);
    await expect(
      isGoogleProviderEnabled({ url: "https://example.supabase.co/", publishableKey: "sb_publishable_x" }, fetchImpl),
    ).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.supabase.co/auth/v1/settings");
    expect(new Headers(init?.headers).get("apikey")).toBe("sb_publishable_x");
  });

  it("returns false when the provider is off and null when unknown", async () => {
    const env = { url: "https://example.supabase.co", publishableKey: "k" };
    await expect(isGoogleProviderEnabled(env, settings(false))).resolves.toBe(false);
    await expect(isGoogleProviderEnabled(env, settings("yes"))).resolves.toBeNull();
    await expect(isGoogleProviderEnabled(env, settings(true, { status: 500 }))).resolves.toBeNull();
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(isGoogleProviderEnabled(env, failing)).resolves.toBeNull();
  });
});

describe("getSignInReadiness", () => {
  it("is ready when every group is set and Google is on", async () => {
    await expect(getSignInReadiness(settings(true))).resolves.toBe("ready");
  });

  it("is not configured when Supabase says Google is off", async () => {
    await expect(getSignInReadiness(settings(false))).resolves.toBe("not_configured");
  });

  it("stays ready when the settings cannot be read", async () => {
    await expect(getSignInReadiness(settings(true, { status: 503 }))).resolves.toBe("ready");
  });

  it("is not configured without any required variable, and does not call Supabase", async () => {
    for (const name of Object.keys(ENV)) {
      vi.stubEnv(name, undefined);
      const fetchImpl = settings(true);
      await expect(getSignInReadiness(fetchImpl)).resolves.toBe("not_configured");
      expect(fetchImpl).not.toHaveBeenCalled();
      vi.stubEnv(name, ENV[name as keyof typeof ENV]);
    }
  });

  it("is not configured with no env at all", async () => {
    for (const name of Object.keys(ENV)) {
      vi.stubEnv(name, undefined);
    }
    const fetchImpl = settings(true);
    await expect(getSignInReadiness(fetchImpl)).resolves.toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
