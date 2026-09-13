// Auth paths and the error codes the sign-in screen understands. Safe for any runtime.

export const LOGIN_PATH = "/login";
export const AUTH_CALLBACK_PATH = "/auth/callback";
export const SIGN_OUT_PATH = "/auth/signout";
export const DEFAULT_NEXT_PATH = "/videos";

export const LOGIN_ERRORS = [
  "not_allowed",
  "missing_permissions",
  "no_refresh_token",
  "sign_in_failed",
  "not_configured",
] as const;

export type LoginError = (typeof LOGIN_ERRORS)[number];

export function parseLoginError(value: unknown): LoginError | null {
  return typeof value === "string" && (LOGIN_ERRORS as readonly string[]).includes(value)
    ? (value as LoginError)
    : null;
}

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

// Pages that stay reachable without a session.
export function isPublicPath(pathname: string): boolean {
  return isUnder(pathname, LOGIN_PATH) || isUnder(pathname, "/auth");
}

export function loginPath(options: { error?: LoginError; next?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.error) {
    params.set("error", options.error);
  }
  if (options.next && options.next !== DEFAULT_NEXT_PATH) {
    params.set("next", options.next);
  }
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}
