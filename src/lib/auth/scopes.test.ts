import { describe, expect, it, vi } from "vitest";
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_SIGN_IN_QUERY_PARAMS,
  GOOGLE_SIGN_IN_SCOPES,
  GOOGLE_TOKENINFO_URL,
  checkGmailScopes,
  missingGmailScopes,
} from "@/lib/auth/scopes";

const BASE_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

function tokenInfo(body: unknown, init: ResponseInit = { status: 200 }) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), init));
}

describe("sign-in request", () => {
  it("asks for full Gmail read and send scope URLs with offline consent", () => {
    expect(GOOGLE_SIGN_IN_SCOPES).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    );
    expect(GOOGLE_SIGN_IN_QUERY_PARAMS).toEqual({ access_type: "offline", prompt: "consent" });
  });
});

describe("missingGmailScopes", () => {
  it("finds nothing missing when both scopes are granted in any order", () => {
    expect(missingGmailScopes(`${GMAIL_SEND_SCOPE} ${BASE_SCOPES}  ${GMAIL_READONLY_SCOPE}`)).toEqual([]);
  });

  it("lists each missing scope", () => {
    expect(missingGmailScopes(`${BASE_SCOPES} ${GMAIL_READONLY_SCOPE}`)).toEqual([GMAIL_SEND_SCOPE]);
    expect(missingGmailScopes(`${BASE_SCOPES} ${GMAIL_SEND_SCOPE}`)).toEqual([GMAIL_READONLY_SCOPE]);
    expect(missingGmailScopes("")).toEqual([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
  });

  it("does not accept partial or look-alike scope strings", () => {
    expect(missingGmailScopes("gmail.readonly gmail.send")).toEqual([GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
    expect(missingGmailScopes(`${GMAIL_READONLY_SCOPE}x ${GMAIL_SEND_SCOPE}.extra`)).toEqual([
      GMAIL_READONLY_SCOPE,
      GMAIL_SEND_SCOPE,
    ]);
  });
});

describe("checkGmailScopes", () => {
  it("posts the token to Google tokeninfo in a header, never in the URL", async () => {
    const fetchImpl = tokenInfo({ scope: `${BASE_SCOPES} ${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}` });
    await expect(checkGmailScopes("ya29.token", fetchImpl)).resolves.toEqual({ status: "granted" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GOOGLE_TOKENINFO_URL);
    expect(String(url)).not.toContain("ya29.token");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ya29.token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports the send scope missing when it was unticked", async () => {
    const fetchImpl = tokenInfo({ scope: `${BASE_SCOPES} ${GMAIL_READONLY_SCOPE}` });
    await expect(checkGmailScopes("token", fetchImpl)).resolves.toEqual({
      status: "missing",
      missing: [GMAIL_SEND_SCOPE],
    });
  });

  it("reports both missing when neither was granted", async () => {
    const fetchImpl = tokenInfo({ scope: BASE_SCOPES });
    await expect(checkGmailScopes("token", fetchImpl)).resolves.toEqual({
      status: "missing",
      missing: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
    });
  });

  it("returns error when Google rejects the token", async () => {
    const fetchImpl = tokenInfo({ error: "invalid_token" }, { status: 400 });
    await expect(checkGmailScopes("token", fetchImpl)).resolves.toEqual({ status: "error" });
  });

  it("returns error for a malformed response", async () => {
    await expect(checkGmailScopes("token", tokenInfo({ scopes: [] }))).resolves.toEqual({ status: "error" });
    const notJson = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    await expect(checkGmailScopes("token", notJson)).resolves.toEqual({ status: "error" });
  });

  it("returns error on network failure or timeout", async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(checkGmailScopes("token", failing)).resolves.toEqual({ status: "error" });

    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(checkGmailScopes("token", hanging, 10)).resolves.toEqual({ status: "error" });
  });

  it("does not call Google without a token", async () => {
    const fetchImpl = tokenInfo({ scope: "" });
    await expect(checkGmailScopes("", fetchImpl)).resolves.toEqual({ status: "error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
