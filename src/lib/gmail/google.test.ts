import { randomBytes } from "node:crypto";
import { gmail } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManualClock } from "@/lib/clock";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { CONTRACT_START, describeGmailPortContract } from "@/lib/gmail/contract";
import { FakeGmailHttpError, FakeGmailNetworkError, createFakeGmail, type FakeGmail } from "@/lib/gmail/fake";
import errors from "@/lib/gmail/fixtures/errors.json";
import { createGoogleGmail, type GoogleGmailOptions } from "@/lib/gmail/google";
import { GmailAuthError, GmailError, GmailTransientError, type GmailPort } from "@/lib/gmail/port";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

const CLIENT_ID = "123-segue.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-client-secret-value";
const TOPIC = "projects/segue-test/topics/gmail";
const REFRESH_TOKEN = "1//refresh-token-original";
const OWNER = "creator@example.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
}

type TokenReply = { status: number; body: unknown };

interface GoogleHttpOptions {
  mailbox?: FakeGmail;
  // Answers the token endpoint. Default: a new access token without a new refresh token.
  token?: (form: URLSearchParams, index: number, request: RecordedRequest) => TokenReply | Promise<TokenReply>;
  // Answers a Gmail request before the mailbox does. Return undefined to pass it on.
  gmail?: (request: RecordedRequest, index: number) => Response | Promise<Response> | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8" } });
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// gaxios waits between retries with setTimeout. This runs those waits at once and records
// their delays, so retry tests stay fast and can check the backoff.
function skipRetryDelays(): number[] {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    return realSetTimeout(callback, 0);
  }) as unknown as typeof setTimeout);
  return delays;
}

// Google's OAuth token endpoint and the Gmail REST API, served from a fake mailbox. Access
// tokens are checked, so every Gmail call must carry one the token endpoint issued.
function createGoogleHttp(options: GoogleHttpOptions = {}) {
  const requests: RecordedRequest[] = [];
  const issued = new Set<string>();
  let tokenCount = 0;
  let gmailCount = 0;

  const route = async (request: RecordedRequest): Promise<Response> => {
    const { url, method } = request;
    if (url.href === TOKEN_URL) {
      const form = new URLSearchParams(request.body ?? "");
      const index = tokenCount;
      tokenCount += 1;
      const reply = (await options.token?.(form, index, request)) ?? {
        status: 200,
        body: { access_token: `ya29.access-${index + 1}`, expires_in: 3599, token_type: "Bearer", scope: "gmail" },
      };
      const accessToken = (reply.body as { access_token?: unknown }).access_token;
      if (reply.status === 200 && typeof accessToken === "string") {
        issued.add(accessToken);
      }
      return json(reply.status, reply.body);
    }
    if (url.origin !== "https://gmail.googleapis.com") {
      return json(404, errors.not_found.body);
    }
    const index = gmailCount;
    gmailCount += 1;
    const custom = await options.gmail?.(request, index);
    if (custom) {
      return custom;
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!issued.has(bearer)) {
      return json(401, errors.unauthorized.body);
    }
    const mailbox = options.mailbox;
    if (!mailbox) {
      throw new Error(`No mailbox for ${method} ${url.pathname}`);
    }
    const match = /^\/gmail\/v1\/users\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) {
      return json(404, errors.not_found.body);
    }
    const userId = decodeURIComponent(match[1]);
    const path = match[2];
    const query = url.searchParams;
    const body = request.body ? JSON.parse(request.body) : undefined;
    const number = (name: string) => (query.has(name) ? Number(query.get(name)) : undefined);
    const text = (name: string) => query.get(name) ?? undefined;
    const users = mailbox.api.users;
    let result: { data: unknown };
    if (method === "POST" && path === "watch") {
      result = await users.watch({ userId, requestBody: body });
    } else if (method === "POST" && path === "stop") {
      await users.stop({ userId });
      return new Response(null, { status: 204 });
    } else if (method === "GET" && path === "profile") {
      result = await users.getProfile({ userId });
    } else if (method === "GET" && path === "history") {
      result = await users.history.list({
        userId,
        startHistoryId: query.get("startHistoryId") ?? "",
        historyTypes: query.getAll("historyTypes"),
        labelId: text("labelId"),
        maxResults: number("maxResults"),
        pageToken: text("pageToken"),
      });
    } else if (method === "GET" && path === "messages") {
      result = await users.messages.list({
        userId,
        q: text("q"),
        labelIds: query.getAll("labelIds"),
        maxResults: number("maxResults"),
        pageToken: text("pageToken"),
      });
    } else if (method === "POST" && path === "messages/send") {
      result = await users.messages.send({ userId, requestBody: body });
    } else if (method === "GET" && path.startsWith("messages/")) {
      result = await users.messages.get({ userId, id: decodeURIComponent(path.slice(9)), format: text("format") });
    } else if (method === "GET" && path.startsWith("threads/")) {
      result = await users.threads.get({ userId, id: decodeURIComponent(path.slice(8)), format: text("format") });
    } else {
      return json(404, errors.not_found.body);
    }
    return json(200, result.data);
  };

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? null : String(init.body),
      signal: init?.signal ?? null,
    };
    requests.push(request);
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof FakeGmailHttpError) {
        return json(error.status, error.response.data);
      }
      if (error instanceof FakeGmailNetworkError) {
        if (error.code === "TimeoutError") {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      }
      throw error;
    }
  };

  return {
    fetchImplementation,
    requests,
    tokenRequests: () => requests.filter((request) => request.url.href === TOKEN_URL),
    gmailRequests: () => requests.filter((request) => request.url.origin === "https://gmail.googleapis.com"),
  };
}

function stubGoogleEnv() {
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("GOOGLE_PUBSUB_TOPIC", TOPIC);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
}

async function connectedStore(refreshToken = REFRESH_TOKEN): Promise<Store> {
  const store = createMemoryStore();
  await store.updateAppState({ googleEmail: OWNER, refreshTokenEnc: encryptSecret(refreshToken) });
  return store;
}

async function readyGmail(options: Partial<GoogleGmailOptions> & { store: Store }): Promise<GmailPort> {
  const client = await createGoogleGmail({ retry: false, ...options });
  if (client.status !== "ready") {
    throw new Error(`Gmail client is ${client.status}`);
  }
  return client.gmail;
}

async function rejection(promise: Promise<unknown>): Promise<GmailError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GmailError);
  return error as GmailError;
}

beforeEach(() => {
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PUBSUB_TOPIC", "TOKEN_ENCRYPTION_KEY"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Gmail over HTTP", () => {
  beforeEach(() => {
    stubGoogleEnv();
  });

  describeGmailPortContract("google", async () => {
    const clock = createManualClock(CONTRACT_START);
    const mailbox = createFakeGmail({ clock, maxPageSize: 2 });
    const http = createGoogleHttp({ mailbox });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    return { port, mailbox, clock };
  });
});

describe("createGoogleGmail", () => {
  it("is not configured without env, and does not read the store", async () => {
    const store = createMemoryStore();
    const getAppState = vi.spyOn(store, "getAppState");
    expect(await createGoogleGmail({ store })).toEqual({ status: "not_configured", reason: "missing_env" });
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("GOOGLE_PUBSUB_TOPIC", TOPIC);
    expect(await createGoogleGmail({ store })).toEqual({ status: "not_configured", reason: "missing_env" });
    expect(getAppState).not.toHaveBeenCalled();
  });

  it("is not configured when an env value is invalid", async () => {
    stubGoogleEnv();
    vi.stubEnv("GOOGLE_CLIENT_ID", "not-a-client-id");
    expect(await createGoogleGmail({ store: createMemoryStore() })).toEqual({ status: "not_configured", reason: "missing_env" });
  });

  it("reports no account before anyone signed in", async () => {
    stubGoogleEnv();
    expect(await createGoogleGmail({ store: createMemoryStore() })).toEqual({ status: "not_configured", reason: "no_account" });
  });

  it("asks for a new sign in when the token is missing or unreadable", async () => {
    stubGoogleEnv();
    const store = createMemoryStore();
    await store.updateAppState({ googleEmail: OWNER });
    const missing = await createGoogleGmail({ store });
    expect(missing.status).toBe("needs_reauth");
    expect(missing.status === "needs_reauth" && missing.error).toBeInstanceOf(GmailAuthError);
    expect(missing.status === "needs_reauth" && missing.error.reason).toBe("missing_token");

    await store.updateAppState({ refreshTokenEnc: "v1.garbage" });
    const unreadable = await createGoogleGmail({ store });
    expect(unreadable.status === "needs_reauth" && unreadable.error.reason).toBe("unreadable_token");

    const encrypted = encryptSecret(REFRESH_TOKEN);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await store.updateAppState({ refreshTokenEnc: encrypted });
    const otherKey = await createGoogleGmail({ store });
    expect(otherKey.status === "needs_reauth" && otherKey.error.reason).toBe("unreadable_token");
  });

  it("returns a ready client with the account and topic without calling Google", async () => {
    stubGoogleEnv();
    const http = createGoogleHttp();
    const client = await createGoogleGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    expect(client).toMatchObject({ status: "ready", googleEmail: OWNER, pubsubTopic: TOPIC });
    expect(http.requests).toHaveLength(0);
  });

  it("builds the Gmail client on an OAuth client holding the stored refresh token", async () => {
    stubGoogleEnv();
    let auth: OAuth2Client | undefined;
    const client = await createGoogleGmail({
      store: await connectedStore(),
      createApi: (oauth) => {
        auth = oauth;
        return gmail({ version: "v1", auth: oauth });
      },
    });
    expect(client.status).toBe("ready");
    expect(auth?.credentials.refresh_token).toBe(REFRESH_TOKEN);
  });
});

describe("Google OAuth and HTTP behavior", () => {
  beforeEach(() => {
    stubGoogleEnv();
  });

  it("refreshes the access token with the client credentials and sends it to Gmail", async () => {
    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const http = createGoogleHttp({ mailbox });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    expect(await port.getProfile()).toEqual({ emailAddress: OWNER, historyId: mailbox.currentHistoryId() });
    await port.getProfile();

    const tokenRequests = http.tokenRequests();
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(tokenRequests[0].body ?? ""))).toEqual({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    });
    expect(http.gmailRequests().map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer ya29.access-1",
      "Bearer ya29.access-1",
    ]);
  });

  it("sends the Gmail request shapes the port relies on", async () => {
    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const http = createGoogleHttp({ mailbox });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    const original = mailbox.deliverEmail({ from: "sponsor@brand.example", subject: "Offer", text: "Hello" });

    await port.watch(TOPIC);
    await port.listHistory("1");
    await port.listInboxAfter(1789369964, 10);
    await port.getMessage(original.id);
    await port.getThread(original.threadId);
    await port.sendReply({
      threadId: original.threadId,
      to: ["sponsor@brand.example"],
      cc: [],
      subject: "Offer",
      bodyText: "Thanks",
      inReplyTo: original.messageId,
      references: [],
    });
    await port.stop();

    const seen = http.gmailRequests().map((request) => {
      const query = new URLSearchParams(request.url.search);
      query.sort();
      return `${request.method} ${request.url.pathname}${query.size > 0 ? `?${query}` : ""}`;
    });
    expect(seen).toEqual([
      "POST /gmail/v1/users/me/watch",
      "GET /gmail/v1/users/me/history?historyTypes=messageAdded&labelId=INBOX&maxResults=500&startHistoryId=1",
      "GET /gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10&q=after%3A1789369964",
      `GET /gmail/v1/users/me/messages/${original.id}?format=full`,
      `GET /gmail/v1/users/me/threads/${original.threadId}?format=metadata`,
      "POST /gmail/v1/users/me/messages/send",
      "POST /gmail/v1/users/me/stop",
    ]);
    const requests = http.gmailRequests();
    expect(JSON.parse(requests[0].body ?? "")).toEqual({ topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
    const send = JSON.parse(requests[5].body ?? "");
    expect(Object.keys(send).sort()).toEqual(["raw", "threadId"]);
    expect(send.threadId).toBe(original.threadId);
    expect(mailbox.sentReplies[0].raw).toBe(send.raw);
  });

  it("maps invalid_grant from the token endpoint to GmailAuthError without leaking secrets", async () => {
    const http = createGoogleHttp({ token: () => errors.invalid_grant });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    const error = await rejection(port.getProfile());
    expect(error).toBeInstanceOf(GmailAuthError);
    expect(error.reason).toBe("invalid_grant");
    expect(error.status).toBe(400);
    const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack, cause: error.cause });
    for (const secret of [REFRESH_TOKEN, CLIENT_SECRET, OWNER]) {
      expect(serialized).not.toContain(secret);
    }
    expect(http.gmailRequests()).toHaveLength(0);
  });

  it("maps a rejected OAuth client to GmailAuthError", async () => {
    const http = createGoogleHttp({ token: () => errors.invalid_client });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    const error = await rejection(port.listHistory("1"));
    expect(error).toBeInstanceOf(GmailAuthError);
    expect(error.reason).toBe("client_rejected");
  });

  it("maps a 401 right after a fresh token to GmailAuthError, and a send refused that way as not sent", async () => {
    const http = createGoogleHttp({ gmail: () => json(401, errors.unauthorized.body) });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    const error = await rejection(port.getProfile());
    expect(error).toBeInstanceOf(GmailAuthError);
    expect(error.reason).toBe("unauthorized");
    const sendError = await rejection(
      port.sendReply({ threadId: "t1", to: ["a@brand.example"], cc: [], subject: "Hi", bodyText: "x", inReplyTo: null, references: [] }),
    );
    expect(sendError).toBeInstanceOf(GmailAuthError);
    expect(sendError.sendOutcome).toBe("not_sent");
    expect(http.tokenRequests()).toHaveLength(1);
  });

  it.each([
    ["403 insufficient scope", errors.insufficient_scope, GmailAuthError, "insufficient_scope"],
    ["403 user rate limit", errors.user_rate_limit, GmailTransientError, "rate_limited"],
    ["403 API disabled", errors.access_not_configured, GmailError, "forbidden"],
    ["429", errors.rate_limit, GmailTransientError, "rate_limited"],
    ["500", errors.server_error, GmailTransientError, "server_error"],
    ["503", errors.unavailable, GmailTransientError, "server_error"],
  ] as const)("maps %s from Gmail", async (_label, fixture, errorClass, reason) => {
    const http = createGoogleHttp({ gmail: () => json(fixture.status, fixture.body) });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation });
    const error = await rejection(port.getThread("191e9b7c1a3f5e22"));
    expect(error).toBeInstanceOf(errorClass);
    expect(error.reason).toBe(reason);
    expect(error.status).toBe(fixture.status);
  });

  it("maps a network failure and a timeout to GmailTransientError", async () => {
    const network = createGoogleHttp({
      gmail: () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
      },
    });
    const networkPort = await readyGmail({ store: await connectedStore(), fetchImplementation: network.fetchImplementation });
    const networkError = await rejection(networkPort.getProfile());
    expect(networkError).toBeInstanceOf(GmailTransientError);
    expect(networkError.reason).toBe("network");

    const slow = createGoogleHttp({ gmail: (request) => waitForAbort(request.signal) });
    const slowPort = await readyGmail({ store: await connectedStore(), fetchImplementation: slow.fetchImplementation, timeoutMs: 30 });
    const timeoutError = await rejection(slowPort.getProfile());
    expect(timeoutError).toBeInstanceOf(GmailTransientError);
    expect(timeoutError.reason).toBe("timeout");
  });

  it("uses the global fetch by default, so a timeout is reported as one and a read is retried once", async () => {
    const slow = createGoogleHttp({ gmail: (request) => waitForAbort(request.signal) });
    vi.stubGlobal("fetch", slow.fetchImplementation);
    const port = await readyGmail({ store: await connectedStore(), timeoutMs: 30, retry: true });
    const error = await rejection(port.getProfile());
    expect(error).toBeInstanceOf(GmailTransientError);
    expect(error.reason).toBe("timeout");
    expect(slow.tokenRequests()).toHaveLength(1);
    expect(slow.gmailRequests().map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /gmail/v1/users/me/profile",
      "GET /gmail/v1/users/me/profile",
    ]);
  });

  it("retries a failed read but never a send", async () => {
    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const original = mailbox.deliverEmail({ from: "sponsor@brand.example", subject: "Offer", text: "Hello" });
    const http = createGoogleHttp({
      mailbox,
      gmail: (request, index) => (index === 0 || request.method === "POST" ? json(503, errors.unavailable.body) : undefined),
    });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: http.fetchImplementation, retry: true });

    expect(await port.getProfile()).toEqual({ emailAddress: OWNER, historyId: mailbox.currentHistoryId() });
    expect(http.gmailRequests()).toHaveLength(2);

    const error = await rejection(
      port.sendReply({
        threadId: original.threadId,
        to: ["sponsor@brand.example"],
        cc: [],
        subject: "Offer",
        bodyText: "Thanks",
        inReplyTo: original.messageId,
        references: [],
      }),
    );
    expect(error).toBeInstanceOf(GmailTransientError);
    expect(error.sendOutcome).toBe("unknown");
    expect(http.gmailRequests().filter((request) => request.method === "POST")).toHaveLength(1);
    expect(mailbox.sentReplies).toHaveLength(0);
  });

  it("retries a read up to twice after a 429 or a 5xx, within about a second", async () => {
    const delays = skipRetryDelays();
    const unavailable = createGoogleHttp({ gmail: () => json(503, errors.unavailable.body) });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: unavailable.fetchImplementation, retry: true });
    const error = await rejection(port.getProfile());
    expect(error).toBeInstanceOf(GmailTransientError);
    expect(error.reason).toBe("server_error");
    expect(unavailable.gmailRequests()).toHaveLength(3);
    expect(delays).toEqual([250, 500]);

    const limited = createGoogleHttp({ gmail: () => json(429, errors.rate_limit.body) });
    const limitedPort = await readyGmail({ store: await connectedStore(), fetchImplementation: limited.fetchImplementation, retry: true });
    expect((await rejection(limitedPort.getProfile())).reason).toBe("rate_limited");
    expect(limited.gmailRequests()).toHaveLength(3);
  });

  it("retries a read after a network error or a timeout only as its first retry", async () => {
    skipRetryDelays();
    const network = createGoogleHttp({
      gmail: () => {
        throw new FakeGmailNetworkError("ECONNRESET");
      },
    });
    const networkPort = await readyGmail({ store: await connectedStore(), fetchImplementation: network.fetchImplementation, retry: true });
    expect((await rejection(networkPort.getProfile())).reason).toBe("network");
    expect(network.gmailRequests()).toHaveLength(2);

    const lateTimeout = createGoogleHttp({
      gmail: (request, index) => (index === 0 ? json(503, errors.unavailable.body) : waitForAbort(request.signal)),
    });
    const latePort = await readyGmail({
      store: await connectedStore(),
      fetchImplementation: lateTimeout.fetchImplementation,
      timeoutMs: 30,
      retry: true,
    });
    expect((await rejection(latePort.getProfile())).reason).toBe("timeout");
    expect(lateTimeout.gmailRequests()).toHaveLength(2);

    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const earlyTimeout = createGoogleHttp({
      mailbox,
      gmail: (request, index) =>
        index === 0 ? waitForAbort(request.signal) : index === 1 ? json(503, errors.unavailable.body) : undefined,
    });
    const earlyPort = await readyGmail({
      store: await connectedStore(),
      fetchImplementation: earlyTimeout.fetchImplementation,
      timeoutMs: 30,
      retry: true,
    });
    expect(await earlyPort.getProfile()).toEqual({ emailAddress: OWNER, historyId: mailbox.currentHistoryId() });
    expect(earlyTimeout.gmailRequests()).toHaveLength(3);
  });

  it("retries a token refresh, a POST, up to 3 times after a 5xx and twice after a timeout, even with read retries off", async () => {
    const delays = skipRetryDelays();
    const unavailable = createGoogleHttp({ token: () => errors.unavailable });
    const port = await readyGmail({ store: await connectedStore(), fetchImplementation: unavailable.fetchImplementation, retry: false });
    const error = await rejection(port.getProfile());
    expect(error).toBeInstanceOf(GmailTransientError);
    expect(error.reason).toBe("server_error");
    expect(unavailable.tokenRequests().map((request) => request.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(unavailable.gmailRequests()).toHaveLength(0);
    expect(delays).toEqual([100, 500, 1500]);

    const slow = createGoogleHttp({ token: (_form, _index, request) => waitForAbort(request.signal) });
    const slowPort = await readyGmail({
      store: await connectedStore(),
      fetchImplementation: slow.fetchImplementation,
      timeoutMs: 30,
      retry: false,
    });
    expect((await rejection(slowPort.getProfile())).reason).toBe("timeout");
    expect(slow.tokenRequests()).toHaveLength(3);
    expect(slow.gmailRequests()).toHaveLength(0);
  });
});

describe("refresh token rotation", () => {
  beforeEach(() => {
    stubGoogleEnv();
  });

  // The memory store saves faster than the fake HTTP round trip ends. A delayed save only
  // lands before the call returns when the port waits for it.
  const delaySaves = (store: Store) => {
    const update = store.updateAppState.bind(store);
    return vi.spyOn(store, "updateAppState").mockImplementation(async (patch) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return update(patch);
    });
  };

  const rotatingToken = (rotated: string) => (_form: URLSearchParams, index: number) => ({
    status: 200,
    body: {
      access_token: `ya29.rotated-${index + 1}`,
      expires_in: 3599,
      token_type: "Bearer",
      ...(index === 0 ? { refresh_token: rotated } : {}),
    },
  });

  it("stores a rotated refresh token before the call returns and uses it from then on", async () => {
    const store = await connectedStore();
    const update = delaySaves(store);
    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const http = createGoogleHttp({ mailbox, token: rotatingToken("1//refresh-token-rotated") });
    let auth: OAuth2Client | undefined;
    const client = await createGoogleGmail({
      store,
      fetchImplementation: http.fetchImplementation,
      retry: false,
      createApi: (oauth) => {
        auth = oauth;
        return gmail({ version: "v1", auth: oauth, retry: false });
      },
    });
    if (client.status !== "ready") {
      throw new Error("not ready");
    }

    expect(await client.gmail.getProfile()).toEqual({ emailAddress: OWNER, historyId: mailbox.currentHistoryId() });
    const state = await store.getAppState();
    expect(decryptSecret(state.refreshTokenEnc ?? "")).toBe("1//refresh-token-rotated");
    expect(state.googleEmail).toBe(OWNER);
    expect(update).toHaveBeenCalledTimes(1);

    await auth?.refreshAccessToken();
    const forms = http.tokenRequests().map((request) => new URLSearchParams(request.body ?? "").get("refresh_token"));
    expect(forms).toEqual([REFRESH_TOKEN, "1//refresh-token-rotated"]);
  });

  it("writes nothing when Google returns the same or no refresh token", async () => {
    const store = await connectedStore();
    const before = (await store.getAppState()).refreshTokenEnc;
    const update = vi.spyOn(store, "updateAppState");
    const http = createGoogleHttp({
      mailbox: createFakeGmail({ ownerEmail: OWNER }),
      token: (_form, index) => ({
        status: 200,
        body: { access_token: `ya29.same-${index}`, expires_in: 3599, ...(index === 0 ? { refresh_token: REFRESH_TOKEN } : {}) },
      }),
    });
    const port = await readyGmail({ store, fetchImplementation: http.fetchImplementation });
    await port.getProfile();
    expect(update).not.toHaveBeenCalled();
    expect((await store.getAppState()).refreshTokenEnc).toBe(before);
  });

  it("keeps a token from a newer sign in", async () => {
    const store = await connectedStore();
    const http = createGoogleHttp({ mailbox: createFakeGmail({ ownerEmail: OWNER }), token: rotatingToken("1//rotated-late") });
    const port = await readyGmail({ store, fetchImplementation: http.fetchImplementation });
    const newer = encryptSecret("1//from-new-sign-in");
    await store.updateAppState({ refreshTokenEnc: newer });
    await port.getProfile();
    expect((await store.getAppState()).refreshTokenEnc).toBe(newer);
  });

  it("stores the rotated token even when the Gmail call fails", async () => {
    const store = await connectedStore();
    delaySaves(store);
    const http = createGoogleHttp({ token: rotatingToken("1//rotated-on-failure"), gmail: () => json(500, errors.server_error.body) });
    const port = await readyGmail({ store, fetchImplementation: http.fetchImplementation });
    expect(await rejection(port.getProfile())).toBeInstanceOf(GmailTransientError);
    expect(decryptSecret((await store.getAppState()).refreshTokenEnc ?? "")).toBe("1//rotated-on-failure");
  });

  it("logs a fixed message and still returns when saving the rotated token fails", async () => {
    const store = await connectedStore();
    vi.spyOn(store, "updateAppState").mockRejectedValue(new Error("database down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mailbox = createFakeGmail({ ownerEmail: OWNER });
    const http = createGoogleHttp({ mailbox, token: rotatingToken("1//rotated-unsaved") });
    const port = await readyGmail({ store, fetchImplementation: http.fetchImplementation });
    expect(await port.getProfile()).toMatchObject({ emailAddress: OWNER });
    expect(logged).toHaveBeenCalledWith("Could not save the rotated Google refresh token");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("1//rotated-unsaved");
  });
});
