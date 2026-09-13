import { describe, expect, it, vi } from "vitest";
import {
  decideCallback,
  runAuthCallback,
  type CallbackFacts,
  type CallbackInput,
  type CallbackPorts,
  type CallbackSession,
} from "@/lib/auth/callback";
import { GMAIL_SEND_SCOPE, type ScopeCheck } from "@/lib/auth/scopes";
import { MissingEnvError } from "@/lib/env";
import { createMemoryStore } from "@/lib/store/memory";
import type { OwnerResolution } from "@/lib/owner";

const SESSION: CallbackSession = {
  userId: "user-1",
  email: "Owner@example.com",
  amr: [{ method: "oauth", timestamp: 1_700_000_000 }],
  providerToken: "ya29.provider",
  providerRefreshToken: "1//refresh",
};

const BASE: CallbackFacts = { code: "code-1", providerError: false, nextPath: null };

function facts(overrides: Partial<CallbackFacts> = {}): CallbackFacts {
  return { ...BASE, session: SESSION, access: "owner", scopes: { status: "granted" }, ...overrides };
}

describe("decideCallback", () => {
  it("fails without a code or with a provider error, without signing out", () => {
    for (const input of [
      { ...BASE, code: null },
      { ...BASE, code: "" },
      { ...BASE, providerError: true },
    ]) {
      expect(decideCallback(input)).toEqual({ kind: "fail", error: "sign_in_failed", signOut: null, deleteUserId: null });
    }
  });

  it("gathers the session, then access, then scopes, in that order", () => {
    expect(decideCallback(BASE)).toEqual({ kind: "gather", fact: "session", code: "code-1" });
    expect(decideCallback({ ...BASE, session: SESSION })).toEqual({ kind: "gather", fact: "access", session: SESSION });
    expect(decideCallback({ ...BASE, session: SESSION, access: "owner" })).toEqual({
      kind: "gather",
      fact: "scopes",
      providerToken: "ya29.provider",
    });
  });

  it("fails without signing out when the code was not exchanged, so nothing was written", () => {
    expect(decideCallback({ ...BASE, session: "not_exchanged" })).toEqual({
      kind: "fail",
      error: "sign_in_failed",
      signOut: null,
      deleteUserId: null,
    });
  });

  it("fails and signs out when the written session could not be verified or rewritten", () => {
    expect(decideCallback({ ...BASE, session: "unverified" })).toEqual({
      kind: "fail",
      error: "sign_in_failed",
      signOut: "local",
      deleteUserId: null,
    });
  });

  it("rejects another account: global sign out and delete that user, without checking scopes", () => {
    const decision = decideCallback({ ...BASE, session: SESSION, access: "not_allowed" });
    expect(decision).toEqual({ kind: "fail", error: "not_allowed", signOut: "global", deleteUserId: "user-1" });
  });

  it("never deletes a user when the allowlist is not configured", () => {
    expect(decideCallback({ ...BASE, session: SESSION, access: "not_configured" })).toEqual({
      kind: "fail",
      error: "not_configured",
      signOut: "local",
      deleteUserId: null,
    });
  });

  it("fails when the owner session has no email or no provider token", () => {
    for (const session of [
      { ...SESSION, email: null },
      { ...SESSION, providerToken: null },
      { ...SESSION, providerToken: "" },
    ]) {
      expect(decideCallback({ ...BASE, session, access: "owner" })).toEqual({
        kind: "fail",
        error: "sign_in_failed",
        signOut: "local",
        deleteUserId: null,
      });
    }
  });

  it("reports missing permissions when a Gmail scope was not granted", () => {
    expect(decideCallback(facts({ scopes: { status: "missing", missing: [GMAIL_SEND_SCOPE] } }))).toEqual({
      kind: "fail",
      error: "missing_permissions",
      signOut: "local",
      deleteUserId: null,
    });
  });

  it("fails when Google could not confirm the scopes", () => {
    expect(decideCallback(facts({ scopes: { status: "error" } }))).toMatchObject({
      kind: "fail",
      error: "sign_in_failed",
    });
  });

  it("checks scopes before the refresh token", () => {
    const noRefresh = { ...SESSION, providerRefreshToken: null };
    expect(
      decideCallback(facts({ session: noRefresh, scopes: { status: "missing", missing: [GMAIL_SEND_SCOPE] } })),
    ).toMatchObject({ error: "missing_permissions" });
    expect(decideCallback(facts({ session: noRefresh }))).toEqual({
      kind: "fail",
      error: "no_refresh_token",
      signOut: "local",
      deleteUserId: null,
    });
    expect(decideCallback(facts({ session: { ...SESSION, providerRefreshToken: "" } }))).toMatchObject({
      error: "no_refresh_token",
    });
  });

  it("connects the account and redirects to /videos by default", () => {
    expect(decideCallback(facts())).toEqual({
      kind: "connect",
      email: "Owner@example.com",
      refreshToken: "1//refresh",
      redirectTo: "/videos",
    });
  });

  it("redirects to a safe next path and ignores unsafe ones", () => {
    expect(decideCallback(facts({ nextPath: "/emails?tab=sent" }))).toMatchObject({ redirectTo: "/emails?tab=sent" });
    for (const nextPath of ["https://evil.example", "//evil.example", "/..//evil.example", "/login"]) {
      expect(decideCallback(facts({ nextPath }))).toMatchObject({ redirectTo: "/videos" });
    }
  });
});

function ownerResolution(store = createMemoryStore()): OwnerResolution {
  return { status: "owner", owner: { email: "owner@example.com", store, demo: false } };
}

function ports(overrides: Partial<CallbackPorts> = {}) {
  const calls: string[] = [];
  const base: CallbackPorts = {
    exchangeCode: vi.fn(async () => {
      calls.push("exchange");
      return SESSION;
    }),
    resolveAccess: vi.fn(() => {
      calls.push("access");
      return ownerResolution();
    }),
    checkScopes: vi.fn(async () => {
      calls.push("scopes");
      return { status: "granted" } as const;
    }),
    signOut: vi.fn(async (scope) => {
      calls.push(`signOut:${scope}`);
    }),
    deleteUser: vi.fn(async (userId) => {
      calls.push(`delete:${userId}`);
      return true;
    }),
    encrypt: vi.fn((plaintext: string) => `enc(${plaintext})`),
  };
  return { ports: { ...base, ...overrides }, calls };
}

describe("runAuthCallback", () => {
  it("saves the encrypted refresh token, clears needs_reauth and redirects", async () => {
    const store = createMemoryStore();
    await store.updateAppState({ needsReauth: true });
    const { ports: p, calls } = ports({ resolveAccess: vi.fn(() => ownerResolution(store)) });

    const location = await runAuthCallback({ code: "code-1", providerError: false, nextPath: "/emails" }, p);

    expect(location).toBe("/emails");
    expect(calls).toEqual(["exchange", "scopes"]);
    expect(p.exchangeCode).toHaveBeenCalledWith("code-1");
    expect(p.checkScopes).toHaveBeenCalledWith("ya29.provider");
    expect(p.encrypt).toHaveBeenCalledWith("1//refresh");
    const state = await store.getAppState();
    expect(state).toMatchObject({ googleEmail: "owner@example.com", refreshTokenEnc: "enc(1//refresh)", needsReauth: false });
    expect(p.signOut).not.toHaveBeenCalled();
  });

  it("does nothing but redirect when the provider returned an error", async () => {
    const { ports: p, calls } = ports();
    expect(await runAuthCallback({ code: null, providerError: true, nextPath: null }, p)).toBe(
      "/login?error=sign_in_failed",
    );
    expect(calls).toEqual([]);
  });

  it("leaves the browser's session alone when the code was not exchanged", async () => {
    const { ports: p, calls } = ports({ exchangeCode: vi.fn(async () => "not_exchanged" as const) });
    expect(await runAuthCallback({ code: "bogus", providerError: false, nextPath: "/emails" }, p)).toBe(
      "/login?error=sign_in_failed&next=%2Femails",
    );
    expect(calls).toEqual([]);
    expect(p.signOut).not.toHaveBeenCalled();
    expect(p.resolveAccess).not.toHaveBeenCalled();
    expect(p.deleteUser).not.toHaveBeenCalled();
  });

  it("signs out when the written session could not be verified or rewritten", async () => {
    const { ports: p, calls } = ports({ exchangeCode: vi.fn(async () => "unverified" as const) });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=sign_in_failed",
    );
    expect(calls).toEqual(["signOut:local"]);
    expect(p.resolveAccess).not.toHaveBeenCalled();
  });

  it("signs out another account globally before deleting it, and never checks its scopes", async () => {
    const { ports: p, calls } = ports({
      resolveAccess: vi.fn(() => ({ status: "not_allowed" }) as const),
    });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=not_allowed",
    );
    expect(calls).toEqual(["exchange", "signOut:global", "delete:user-1"]);
    expect(p.checkScopes).not.toHaveBeenCalled();
    expect(p.encrypt).not.toHaveBeenCalled();
  });

  it("still redirects with not allowed when sign out or delete fails", async () => {
    const { ports: p } = ports({
      resolveAccess: vi.fn(() => ({ status: "not_allowed" }) as const),
      signOut: vi.fn(async () => {
        throw new Error("network");
      }),
      deleteUser: vi.fn(async () => {
        throw new Error("admin down");
      }),
    });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=not_allowed",
    );
    expect(p.deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("reports missing permissions and saves nothing", async () => {
    const store = createMemoryStore();
    const { ports: p, calls } = ports({
      resolveAccess: vi.fn(() => ownerResolution(store)),
      checkScopes: vi.fn(async (): Promise<ScopeCheck> => ({ status: "missing", missing: [GMAIL_SEND_SCOPE] })),
    });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=missing_permissions",
    );
    expect(calls).toEqual(["exchange", "signOut:local"]);
    expect((await store.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("reports no refresh token and saves nothing", async () => {
    const store = createMemoryStore();
    const { ports: p } = ports({
      exchangeCode: vi.fn(async () => ({ ...SESSION, providerRefreshToken: null })),
      resolveAccess: vi.fn(() => ownerResolution(store)),
    });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=no_refresh_token",
    );
    expect(p.encrypt).not.toHaveBeenCalled();
    expect(p.signOut).toHaveBeenCalledWith("local");
    expect((await store.getAppState()).refreshTokenEnc).toBeNull();
  });

  it("treats a throwing exchange, access check or scope check as a failure", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("boom");
    });
    const cases: [Partial<CallbackPorts>, string][] = [
      [{ exchangeCode: throwing }, "/login?error=sign_in_failed"],
      [
        {
          resolveAccess: vi.fn(() => {
            throw new Error("boom");
          }),
        },
        "/login?error=not_configured",
      ],
      [{ checkScopes: throwing }, "/login?error=sign_in_failed"],
    ];
    for (const [override, expected] of cases) {
      const { ports: p } = ports(override);
      expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(expected);
      expect(p.signOut).toHaveBeenCalledWith("local");
      expect(p.encrypt).not.toHaveBeenCalled();
      expect(p.deleteUser).not.toHaveBeenCalled();
    }
  });

  it("reports not configured when the encryption key is missing", async () => {
    const { ports: p } = ports({
      encrypt: vi.fn(() => {
        throw new MissingEnvError("tokenEncryption", ["TOKEN_ENCRYPTION_KEY"]);
      }),
    });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=not_configured",
    );
    expect(p.signOut).toHaveBeenCalledWith("local");
  });

  it("reports sign in failed when saving fails", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "updateAppState").mockRejectedValueOnce(new Error("database"));
    const { ports: p } = ports({ resolveAccess: vi.fn(() => ownerResolution(store)) });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: "/emails" }, p)).toBe(
      "/login?error=sign_in_failed&next=%2Femails",
    );
    expect(p.signOut).toHaveBeenCalledWith("local");
  });

  it("keeps the page to return to on the sign-in screen after a failure", async () => {
    const missingSend: Partial<CallbackPorts> = {
      checkScopes: vi.fn(async (): Promise<ScopeCheck> => ({ status: "missing", missing: [GMAIL_SEND_SCOPE] })),
    };
    const notAllowed: Partial<CallbackPorts> = { resolveAccess: vi.fn(() => ({ status: "not_allowed" }) as const) };
    const cases: [CallbackInput, Partial<CallbackPorts>, string][] = [
      [{ code: null, providerError: true, nextPath: "/emails?tab=sent" }, {}, "/login?error=sign_in_failed&next=%2Femails%3Ftab%3Dsent"],
      [{ code: "c", providerError: false, nextPath: "/emails" }, missingSend, "/login?error=missing_permissions&next=%2Femails"],
      [{ code: "c", providerError: false, nextPath: "/sponsorships" }, notAllowed, "/login?error=not_allowed&next=%2Fsponsorships"],
    ];
    // Unsafe or default paths are left out, as on a successful sign in.
    for (const nextPath of ["https://evil.example", "//evil.example", "/videos", "/login?next=/emails"]) {
      cases.push([{ code: "c", providerError: false, nextPath }, missingSend, "/login?error=missing_permissions"]);
    }
    for (const [input, override, expected] of cases) {
      const { ports: p } = ports(override);
      expect(await runAuthCallback(input, p)).toBe(expected);
    }
  });

  it("never treats an unexpected signed out resolution as the owner", async () => {
    const { ports: p } = ports({ resolveAccess: vi.fn(() => ({ status: "signed_out" }) as const) });
    expect(await runAuthCallback({ code: "c", providerError: false, nextPath: null }, p)).toBe(
      "/login?error=not_configured",
    );
    expect(p.deleteUser).not.toHaveBeenCalled();
    expect(p.encrypt).not.toHaveBeenCalled();
  });
});
