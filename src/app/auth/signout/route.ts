import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH } from "@/lib/auth/routes";
import { isDemoMode } from "@/lib/demo/guard";
import { createClient } from "@/lib/supabase/server";

function isSupabaseAuthCookie(name: string): boolean {
  return name.startsWith("sb-") && name.includes("-auth-token");
}

// Signs out this browser. POST only, and only from this site, so another page cannot
// sign the owner out with a hidden form.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== request.nextUrl.origin) {
    return new NextResponse(null, { status: 403 });
  }
  if (!isDemoMode()) {
    try {
      const supabase = await createClient();
      await supabase?.auth.signOut({ scope: "local" });
    } catch {
      // Revoking can fail when Supabase is unreachable; the cookies are cleared below anyway.
    }
  }
  const response = NextResponse.redirect(new URL(LOGIN_PATH, request.url), 303);
  for (const cookie of request.cookies.getAll()) {
    if (isSupabaseAuthCookie(cookie.name)) {
      // An epoch expiry, unlike Max-Age=0, survives Next merging these with cookies() writes.
      response.cookies.delete({ name: cookie.name, path: "/" });
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
