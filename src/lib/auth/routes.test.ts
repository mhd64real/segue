import { describe, expect, it } from "vitest";
import { LOGIN_ERRORS, isPublicPath, loginPath, parseLoginError } from "@/lib/auth/routes";

describe("parseLoginError", () => {
  it("accepts only known codes", () => {
    for (const code of LOGIN_ERRORS) {
      expect(parseLoginError(code)).toBe(code);
    }
    for (const value of [undefined, null, "", "NOT_ALLOWED", "<script>", ["not_allowed"], 1]) {
      expect(parseLoginError(value)).toBeNull();
    }
  });
});

describe("isPublicPath", () => {
  it("keeps the sign-in screen and auth routes reachable", () => {
    for (const path of ["/login", "/login/", "/auth", "/auth/callback", "/auth/signout"]) {
      expect(isPublicPath(path)).toBe(true);
    }
  });

  it("protects every other page", () => {
    for (const path of ["/", "/videos", "/loginx", "/authors", "/videos/login", "/api/auth"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});

describe("loginPath", () => {
  it("builds the sign-in URL with an error and a next path", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath({ error: "not_allowed" })).toBe("/login?error=not_allowed");
    expect(loginPath({ next: "/emails?tab=sent" })).toBe("/login?next=%2Femails%3Ftab%3Dsent");
    expect(loginPath({ error: "sign_in_failed", next: "/sponsorships" })).toBe(
      "/login?error=sign_in_failed&next=%2Fsponsorships",
    );
  });

  it("leaves out the default next path", () => {
    expect(loginPath({ next: "/videos" })).toBe("/login");
  });
});
