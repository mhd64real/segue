import { NextResponse, type NextRequest } from "next/server";
import { sanitizeNextPath } from "@/lib/auth/next-path";
import { isPublicPath, loginPath } from "@/lib/auth/routes";
import { isDemoMode } from "@/lib/demo/guard";
import { updateSession } from "@/lib/supabase/proxy";

// Refreshes the Supabase session and sends signed-out page visits to the sign-in screen.
// This is navigation only: every page, action and owner route still checks the owner
// through src/lib/owner.ts. Without Supabase env, and in demo mode, requests pass through.

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) {
    return NextResponse.next();
  }
  const { response, claims, configured } = await updateSession(request);
  if (!configured || claims || !isProtectedPageRequest(request)) {
    return response;
  }

  const { pathname, search } = request.nextUrl;
  const next = pathname === "/" ? undefined : sanitizeNextPath(`${pathname}${search}`);
  const target = new URL(loginPath({ next }), request.url);
  const redirect = NextResponse.redirect(target);
  // Keep cookie changes from the refresh attempt, such as a cleared expired session.
  for (const cookie of response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  redirect.headers.set("Cache-Control", "private, no-store");
  return redirect;
}

// Page navigations only. Server Actions (POST) and API routes answer unauthorized
// themselves instead of being redirected.
function isProtectedPageRequest(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  return !isPublicPath(pathname) && pathname !== "/api" && !pathname.startsWith("/api/");
}

export const config = {
  matcher: [
    "/((?!_next/|favicon\\.ico$|api/gmail/push(?:/|$)|api/cron(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|bmp|txt|xml|json|webmanifest|map|woff2?)$).*)",
  ],
};
