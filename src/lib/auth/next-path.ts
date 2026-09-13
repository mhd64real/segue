import { AUTH_CALLBACK_PATH, DEFAULT_NEXT_PATH, isPublicPath } from "@/lib/auth/routes";

// Where to go after sign in. Only same-origin relative paths pass; anything else becomes
// the default, so a crafted link can never redirect off the site. Safe for any runtime.

const BASE = "http://segue.invalid";
const MAX_LENGTH = 2048;

// The path travels from the sign-in button to the callback in this short-lived cookie,
// so the OAuth redirect URL stays exactly /auth/callback and matches the Supabase allow list.
export const NEXT_PATH_COOKIE = "segue_next";
export const NEXT_PATH_COOKIE_MAX_AGE = 600;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sanitizeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) {
    return DEFAULT_NEXT_PATH;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || hasControlCharacters(value)) {
    return DEFAULT_NEXT_PATH;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== BASE) {
    return DEFAULT_NEXT_PATH;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can normalize "/..//host" into "//host", which browsers read as another origin.
  if (!path.startsWith("/") || path.startsWith("//") || isPublicPath(url.pathname)) {
    return DEFAULT_NEXT_PATH;
  }
  return path;
}

// Cookie string for document.cookie. A default path clears the cookie.
export function nextPathCookie(next: string, secure: boolean): string {
  const path = sanitizeNextPath(next);
  const value = path === DEFAULT_NEXT_PATH ? "" : encodeURIComponent(path);
  const maxAge = value ? NEXT_PATH_COOKIE_MAX_AGE : 0;
  return `${NEXT_PATH_COOKIE}=${value}; Path=${AUTH_CALLBACK_PATH}; Max-Age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
