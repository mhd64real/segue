import "server-only";
import type { JwtPayload } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { loginPath } from "@/lib/auth/routes";
import { isDemoMode } from "@/lib/demo/guard";
import { DEMO_OWNER_EMAIL, getDemoStore } from "@/lib/demo/store";
import { readEnv } from "@/lib/env";
import { createSupabaseStore } from "@/lib/store/supabase";
import type { Store } from "@/lib/store/types";
import { createAdminClientOrNull } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The single data gate. Pages, Server Actions and owner routes get a Store only from
// here. Every call checks verified Supabase claims against ALLOWED_EMAIL and requires a
// Google sign-in, because a layout check does not run again for each action. Missing env of any kind means no
// owner. Demo mode returns the demo store without touching Supabase.

export interface Owner {
  email: string;
  store: Store;
  demo: boolean;
}

export type OwnerResolution =
  | { status: "owner"; owner: Owner }
  | { status: "signed_out" }
  | { status: "not_allowed" }
  | { status: "not_configured" };

export interface Unauthorized {
  ok: false;
  error: "unauthorized";
}

export type OwnerForAction = ({ ok: true } & Owner) | Unauthorized;

export function unauthorized(): Unauthorized {
  return { ok: false, error: "unauthorized" };
}

export function isUnauthorized(value: unknown): value is Unauthorized {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<Unauthorized>).ok === false &&
    (value as Partial<Unauthorized>).error === "unauthorized"
  );
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  return email ? email : null;
}

function ownerEnvConfigured(): boolean {
  return readEnv("supabasePublic") !== null && readEnv("owner") !== null && readEnv("supabaseAdmin") !== null;
}

// True when the session was created by an OAuth sign-in. Google is the only OAuth provider
// enabled, so this rules out a password, OTP or magic link session for the same email.
// amr comes as strings or as { method, timestamp } entries.
function signedInWithOAuth(amr: unknown): boolean {
  if (!Array.isArray(amr)) {
    return false;
  }
  return amr.some((entry: unknown) => {
    const method = typeof entry === "object" && entry !== null ? (entry as { method?: unknown }).method : entry;
    return method === "oauth";
  });
}

// For claims already verified by Supabase Auth (the cookie session, or the access token
// the callback just received). The Store is created only after the email and the sign-in
// method match. Another account is not allowed as soon as ALLOWED_EMAIL is known, even if
// other env is missing.
export function resolveOwnerFromClaims(claims: Pick<JwtPayload, "email" | "amr"> | null): OwnerResolution {
  const ownerEnv = readEnv("owner");
  const allowed = normalizeEmail(ownerEnv?.allowedEmail);
  if (!allowed) {
    return { status: "not_configured" };
  }
  if (!claims) {
    return { status: "signed_out" };
  }
  const email = normalizeEmail(claims.email);
  if (!email || email !== allowed || !signedInWithOAuth(claims.amr)) {
    return { status: "not_allowed" };
  }
  const admin = ownerEnvConfigured() ? createAdminClientOrNull() : null;
  if (!admin) {
    return { status: "not_configured" };
  }
  return { status: "owner", owner: { email, store: createSupabaseStore(admin), demo: false } };
}

async function readSessionClaims(): Promise<JwtPayload | null> {
  try {
    const supabase = await createClient();
    if (!supabase) {
      return null;
    }
    const { data, error } = await supabase.auth.getClaims();
    return error || !data ? null : data.claims;
  } catch {
    return null;
  }
}

export async function resolveOwner(): Promise<OwnerResolution> {
  try {
    if (isDemoMode()) {
      return { status: "owner", owner: { email: DEMO_OWNER_EMAIL, store: await getDemoStore(), demo: true } };
    }
    if (!ownerEnvConfigured()) {
      return { status: "not_configured" };
    }
    return resolveOwnerFromClaims(await readSessionClaims());
  } catch {
    return { status: "signed_out" };
  }
}

// For Server Components and pages. Redirects to the sign-in screen unless the owner is
// signed in. Memoized per request, so a layout and its page share one check.
export const ownerStore = cache(async (): Promise<Owner> => {
  await connection();
  const resolution = await resolveOwner();
  if (resolution.status === "owner") {
    return resolution.owner;
  }
  redirect(resolution.status === "not_allowed" ? loginPath({ error: "not_allowed" }) : loginPath());
});

// For Server Actions and owner routes. Never throws and never says why access failed.
// Call it first, before reading any input.
export async function ownerStoreForAction(): Promise<OwnerForAction> {
  const resolution = await resolveOwner();
  return resolution.status === "owner" ? { ok: true, ...resolution.owner } : unauthorized();
}
