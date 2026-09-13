import type { JwtPayload } from "@supabase/supabase-js";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { loginPath, type LoginError } from "@/lib/auth/routes";
import type { ScopeCheck } from "@/lib/auth/scopes";
import { InvalidEnvError, MissingEnvError } from "@/lib/env";
import type { OwnerResolution } from "@/lib/owner";

// The OAuth callback as a small state machine. decideCallback is pure: given the facts
// gathered so far it either asks for the next fact or settles the outcome. The runner
// gathers facts through injected ports and performs the outcome's side effects.

export interface CallbackSession {
  // From claims verified against the access token Supabase just issued.
  userId: string;
  email: string | null;
  // How this session signed in. The owner gate accepts only a Google (OAuth) sign-in.
  amr: JwtPayload["amr"];
  providerToken: string | null;
  providerRefreshToken: string | null;
}

export type CallbackAccess = Exclude<OwnerResolution["status"], "signed_out">;

// "not_exchanged": the code was refused, so nothing was written and any session the browser
// already has stays. "unverified": the exchange wrote a session, but its claims check or the
// rewrite without the Google tokens failed.
export type SessionFailure = "not_exchanged" | "unverified";

export interface CallbackFacts {
  code: string | null;
  // The provider or Supabase sent an error instead of a code (for example, consent was cancelled).
  providerError: boolean;
  nextPath: string | null;
  // undefined: not gathered yet.
  session?: CallbackSession | SessionFailure;
  access?: CallbackAccess;
  scopes?: ScopeCheck;
}

export type SignOutScope = "local" | "global";

export interface FailDecision {
  kind: "fail";
  error: LoginError;
  signOut: SignOutScope | null;
  deleteUserId: string | null;
}

export type CallbackDecision =
  | { kind: "gather"; fact: "session"; code: string }
  | { kind: "gather"; fact: "access"; session: CallbackSession }
  | { kind: "gather"; fact: "scopes"; providerToken: string }
  | FailDecision
  | { kind: "connect"; email: string; refreshToken: string; redirectTo: string };

function fail(error: LoginError, signOut: SignOutScope | null, deleteUserId: string | null = null): FailDecision {
  return { kind: "fail", error, signOut, deleteUserId };
}

export function decideCallback(facts: CallbackFacts): CallbackDecision {
  if (facts.providerError || !facts.code) {
    return fail("sign_in_failed", null);
  }
  if (facts.session === undefined) {
    return { kind: "gather", fact: "session", code: facts.code };
  }
  const session = facts.session;
  if (session === "not_exchanged") {
    // Signing out here would let any site end the owner's session with a link to this route.
    return fail("sign_in_failed", null);
  }
  if (session === "unverified") {
    return fail("sign_in_failed", "local");
  }
  if (facts.access === undefined) {
    return { kind: "gather", fact: "access", session };
  }
  if (facts.access === "not_configured") {
    return fail("not_configured", "local");
  }
  if (facts.access === "not_allowed") {
    // Revoke every session of that account first: deleting a user does not expire its tokens.
    return fail("not_allowed", "global", session.userId);
  }
  if (!session.email || !session.providerToken) {
    return fail("sign_in_failed", "local");
  }
  if (facts.scopes === undefined) {
    return { kind: "gather", fact: "scopes", providerToken: session.providerToken };
  }
  if (facts.scopes.status === "error") {
    return fail("sign_in_failed", "local");
  }
  if (facts.scopes.status === "missing") {
    return fail("missing_permissions", "local");
  }
  if (!session.providerRefreshToken) {
    return fail("no_refresh_token", "local");
  }
  return {
    kind: "connect",
    email: session.email,
    refreshToken: session.providerRefreshToken,
    redirectTo: sanitizeNextPath(facts.nextPath),
  };
}

export interface CallbackPorts {
  // Exchanges the code, verifies the new access token and rewrites the session cookie.
  exchangeCode(code: string): Promise<CallbackSession | SessionFailure>;
  resolveAccess(session: CallbackSession): OwnerResolution | Promise<OwnerResolution>;
  checkScopes(providerToken: string): Promise<ScopeCheck>;
  signOut(scope: SignOutScope): Promise<void>;
  // Resolves false when the admin env is missing and nothing was deleted.
  deleteUser(userId: string): Promise<boolean>;
  encrypt(plaintext: string): string;
}

export type CallbackInput = Pick<CallbackFacts, "code" | "providerError" | "nextPath">;

async function settle<T>(work: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

// Returns the relative path to redirect to. Never throws.
export async function runAuthCallback(input: CallbackInput, ports: CallbackPorts): Promise<string> {
  const facts: CallbackFacts = { ...input };
  let resolution: OwnerResolution | undefined;

  for (;;) {
    const decision = decideCallback(facts);

    if (decision.kind === "gather") {
      if (decision.fact === "session") {
        const { code } = decision;
        // A throw can come after the session was written, so it is signed out.
        facts.session = (await settle(() => ports.exchangeCode(code))) ?? "unverified";
      } else if (decision.fact === "access") {
        const { session } = decision;
        resolution = (await settle(() => ports.resolveAccess(session))) ?? { status: "not_configured" };
        // A verified session is never signed out; treat anything unexpected as not configured.
        facts.access = resolution.status === "signed_out" ? "not_configured" : resolution.status;
      } else {
        const { providerToken } = decision;
        facts.scopes = (await settle(() => ports.checkScopes(providerToken))) ?? { status: "error" };
      }
      continue;
    }

    if (decision.kind === "fail") {
      return failWith(decision, facts, ports);
    }

    if (resolution?.status !== "owner") {
      return failWith(fail("not_configured", "local"), facts, ports);
    }
    let refreshTokenEnc: string;
    try {
      refreshTokenEnc = ports.encrypt(decision.refreshToken);
    } catch (error) {
      const notConfigured = error instanceof MissingEnvError || error instanceof InvalidEnvError;
      return failWith(fail(notConfigured ? "not_configured" : "sign_in_failed", "local"), facts, ports);
    }
    const { store, email } = resolution.owner;
    const saved = await settle(() => store.updateAppState({ googleEmail: email, refreshTokenEnc, needsReauth: false }));
    if (saved === undefined) {
      return failWith(fail("sign_in_failed", "local"), facts, ports);
    }
    return decision.redirectTo;
  }
}

async function failWith(decision: FailDecision, facts: CallbackFacts, ports: CallbackPorts): Promise<string> {
  const { signOut, deleteUserId } = decision;
  if (signOut) {
    await settle(() => ports.signOut(signOut));
  }
  if (deleteUserId) {
    await settle(() => ports.deleteUser(deleteUserId));
  }
  // The callback clears the next cookie, so the sign-in screen carries the page to return to.
  return loginPath({ error: decision.error, next: sanitizeNextPath(facts.nextPath) });
}
