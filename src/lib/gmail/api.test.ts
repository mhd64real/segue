import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  createGmailApiPort,
  sendOutcomeFor,
  toGmailError,
  type GmailApi,
} from "@/lib/gmail/api";
import errors from "@/lib/gmail/fixtures/errors.json";
import historyEmpty from "@/lib/gmail/fixtures/history-empty.json";
import historyPage1 from "@/lib/gmail/fixtures/history-page-1.json";
import historyPage2 from "@/lib/gmail/fixtures/history-page-2.json";
import historyPage3 from "@/lib/gmail/fixtures/history-page-3.json";
import nestedMixed from "@/lib/gmail/fixtures/message-nested-mixed.json";
import messagesPage1 from "@/lib/gmail/fixtures/messages-list-page-1.json";
import messagesPage2 from "@/lib/gmail/fixtures/messages-list-page-2.json";
import profile from "@/lib/gmail/fixtures/profile.json";
import sendResponse from "@/lib/gmail/fixtures/send-response.json";
import threadMetadata from "@/lib/gmail/fixtures/thread-metadata.json";
import watchResponse from "@/lib/gmail/fixtures/watch-response.json";
import { parseGmailMessage } from "@/lib/gmail/mime";
import {
  GmailAuthError,
  GmailError,
  GmailNotFoundError,
  GmailTransientError,
  type GmailPort,
  type SendReplyInput,
} from "@/lib/gmail/port";
import { buildReplyMessage } from "@/lib/gmail/reply";

type ErrorName = keyof typeof errors;

const SECRET_TOKEN = "ya29.a0-secret-access-token";
const SECRET_EMAIL = "sponsor-secret@brand.example";

// Shaped like a gaxios error: the request config (with credentials and the email), the
// response with Google's error body, and the status.
function httpError(name: ErrorName) {
  const { status, body } = errors[name];
  return Object.assign(new Error(`Request failed: ${SECRET_EMAIL}`), {
    config: { headers: { authorization: `Bearer ${SECRET_TOKEN}` }, data: { raw: SECRET_EMAIL } },
    response: { status, data: structuredClone(body), headers: {} },
    status,
    code: status,
  });
}

function networkError(code: string) {
  return Object.assign(new Error("fetch failed"), {
    config: { headers: { authorization: `Bearer ${SECRET_TOKEN}` } },
    cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket"), { code }) }),
  });
}

function createMockApi() {
  return {
    users: {
      watch: vi.fn<GmailApi["users"]["watch"]>(),
      stop: vi.fn<GmailApi["users"]["stop"]>(),
      getProfile: vi.fn<GmailApi["users"]["getProfile"]>(),
      history: { list: vi.fn<GmailApi["users"]["history"]["list"]>() },
      messages: {
        list: vi.fn<GmailApi["users"]["messages"]["list"]>(),
        get: vi.fn<GmailApi["users"]["messages"]["get"]>(),
        send: vi.fn<GmailApi["users"]["messages"]["send"]>(),
      },
      threads: { get: vi.fn<GmailApi["users"]["threads"]["get"]>() },
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<GmailError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GmailError);
  return error as GmailError;
}

let api: ReturnType<typeof createMockApi>;
let port: GmailPort;

beforeEach(() => {
  api = createMockApi();
  port = createGmailApiPort(api);
});

describe("toGmailError", () => {
  it.each<[string, () => unknown, new (...args: never[]) => GmailError, GmailError["reason"], number | null]>([
    ["invalid_grant from the token endpoint", () => httpError("invalid_grant"), GmailAuthError, "invalid_grant", 400],
    ["invalid_client from the token endpoint", () => httpError("invalid_client"), GmailAuthError, "client_rejected", 401],
    ["401 after the token refresh", () => httpError("unauthorized"), GmailAuthError, "unauthorized", 401],
    ["403 with missing scopes", () => httpError("insufficient_scope"), GmailAuthError, "insufficient_scope", 403],
    ["403 user rate limit", () => httpError("user_rate_limit"), GmailTransientError, "rate_limited", 403],
    ["403 with the API switched off", () => httpError("access_not_configured"), GmailError, "forbidden", 403],
    ["429", () => httpError("rate_limit"), GmailTransientError, "rate_limited", 429],
    ["500", () => httpError("server_error"), GmailTransientError, "server_error", 500],
    ["503", () => httpError("unavailable"), GmailTransientError, "server_error", 503],
    ["404", () => httpError("not_found"), GmailNotFoundError, "not_found", 404],
    ["400", () => httpError("bad_request"), GmailError, "bad_request", 400],
    ["408", () => ({ response: { status: 408, data: "" } }), GmailTransientError, "timeout", 408],
    ["418", () => ({ status: 418 }), GmailError, "unexpected", 418],
    ["a reset connection", () => networkError("ECONNRESET"), GmailTransientError, "network", null],
    ["a DNS failure", () => networkError("ENOTFOUND"), GmailTransientError, "network", null],
    ["a timeout", () => Object.assign(new Error("aborted"), { code: "TimeoutError" }), GmailTransientError, "timeout", null],
    ["a DOMException timeout", () => new DOMException("The operation timed out.", "TimeoutError"), GmailTransientError, "timeout", null],
    ["a gaxios error without response or code", () => ({ config: {}, message: "fetch failed" }), GmailTransientError, "network", null],
    ["an ordinary error", () => new TypeError("x is undefined"), GmailError, "unexpected", null],
    ["a thrown string", () => "boom", GmailError, "unexpected", null],
  ])("maps %s", (_label, make, errorClass, reason, status) => {
    const error = toGmailError(make());
    expect(error).toBeInstanceOf(errorClass);
    expect(error.reason).toBe(reason);
    expect(error.status).toBe(status);
    if (errorClass === GmailError) {
      expect(error).not.toBeInstanceOf(GmailAuthError);
      expect(error).not.toBeInstanceOf(GmailTransientError);
    }
  });

  it("keeps nothing of the original error", () => {
    const error = toGmailError(httpError("unauthorized"));
    const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe("Google did not accept the stored credentials");
  });

  it("returns a GmailError unchanged", () => {
    const original = new GmailTransientError("network");
    expect(toGmailError(original)).toBe(original);
  });

  it("tells whether a failed send may have gone out", () => {
    expect(sendOutcomeFor(new GmailAuthError("invalid_grant"))).toBe("not_sent");
    expect(sendOutcomeFor(new GmailNotFoundError())).toBe("not_sent");
    expect(sendOutcomeFor(new GmailTransientError("rate_limited", { status: 429 }))).toBe("not_sent");
    expect(sendOutcomeFor(new GmailError("bad_request"))).toBe("not_sent");
    expect(sendOutcomeFor(new GmailTransientError("server_error", { status: 502 }))).toBe("unknown");
    expect(sendOutcomeFor(new GmailTransientError("network"))).toBe("unknown");
    expect(sendOutcomeFor(new GmailTransientError("timeout"))).toBe("unknown");
    expect(sendOutcomeFor(new GmailError("unexpected"))).toBe("unknown");
  });
});

describe("watch and stop", () => {
  it("watches INBOX with the topic and reads the response", async () => {
    api.users.watch.mockResolvedValue({ data: watchResponse });
    expect(await port.watch("projects/segue-123/topics/gmail")).toEqual({
      historyId: "4840112",
      expiration: new Date(1790150400000),
    });
    expect(api.users.watch).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { topicName: "projects/segue-123/topics/gmail", labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    });
  });

  it("refuses a malformed topic and a malformed response", async () => {
    expect((await rejection(port.watch("topics/gmail"))).reason).toBe("bad_request");
    expect(api.users.watch).not.toHaveBeenCalled();
    api.users.watch.mockResolvedValue({ data: { historyId: "12", expiration: "soon" } });
    expect((await rejection(port.watch("projects/p/topics/t"))).reason).toBe("invalid_response");
    api.users.watch.mockResolvedValue({ data: { expiration: "1790150400000" } });
    expect((await rejection(port.watch("projects/p/topics/t"))).reason).toBe("invalid_response");
  });

  it("stops the watch and maps its errors", async () => {
    api.users.stop.mockResolvedValue({ data: "" });
    await expect(port.stop()).resolves.toBeUndefined();
    expect(api.users.stop).toHaveBeenCalledWith({ userId: "me" });
    api.users.stop.mockRejectedValue(httpError("invalid_grant"));
    expect(await rejection(port.stop())).toBeInstanceOf(GmailAuthError);
  });
});

describe("listHistory", () => {
  const pages: Record<string, unknown> = {
    "": historyPage1,
    [historyPage1.nextPageToken]: historyPage2,
    [historyPage2.nextPageToken]: historyPage3,
  };

  beforeEach(() => {
    api.users.history.list.mockImplementation(async (params) => ({ data: pages[params.pageToken ?? ""] as never }));
  });

  it("pages through messageAdded records for INBOX and keeps each message once", async () => {
    expect(await port.listHistory("4839100")).toEqual({
      status: "ok",
      messages: [
        { id: "191e8a2f4c0b7d11", threadId: "191e8a2f4c0b7d11", labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"] },
        { id: "191e9b7c1a3f5e22", threadId: "191e9b7c1a3f5e22", labelIds: ["INBOX", "CATEGORY_PERSONAL"] },
        { id: "191f0c6a8e2d4b55", threadId: "191e9b7c1a3f5e22", labelIds: ["IMPORTANT", "INBOX"] },
        { id: "191f5d0e33aa9c01", threadId: "191f5d0e33aa9c01", labelIds: ["UNREAD", "INBOX", "SENT"] },
      ],
      historyId: "4840112",
    });
    expect(api.users.history.list.mock.calls.map(([params]) => params)).toEqual([
      { userId: "me", startHistoryId: "4839100", historyTypes: ["messageAdded"], labelId: "INBOX", maxResults: DEFAULT_HISTORY_PAGE_SIZE, pageToken: undefined },
      { userId: "me", startHistoryId: "4839100", historyTypes: ["messageAdded"], labelId: "INBOX", maxResults: DEFAULT_HISTORY_PAGE_SIZE, pageToken: historyPage1.nextPageToken },
      { userId: "me", startHistoryId: "4839100", historyTypes: ["messageAdded"], labelId: "INBOX", maxResults: DEFAULT_HISTORY_PAGE_SIZE, pageToken: historyPage2.nextPageToken },
    ]);
  });

  it("stops at the page limit and continues from the last record read", async () => {
    const limited = createGmailApiPort(api, { maxHistoryPages: 2, historyPageSize: 2 });
    const result = await limited.listHistory("4839100");
    expect(result).toMatchObject({ status: "ok", historyId: "4840001" });
    expect(result.status === "ok" && result.messages.map((message) => message.id)).toEqual([
      "191e8a2f4c0b7d11",
      "191e9b7c1a3f5e22",
      "191f0c6a8e2d4b55",
    ]);
    expect(api.users.history.list).toHaveBeenCalledTimes(2);
    expect(api.users.history.list.mock.calls[0][0].maxResults).toBe(2);
  });

  it("returns no messages and the mailbox history id when nothing changed", async () => {
    api.users.history.list.mockResolvedValue({ data: historyEmpty });
    expect(await port.listHistory("4840112")).toEqual({ status: "ok", messages: [], historyId: "4840112" });
  });

  it("never returns a history id below the start id", async () => {
    api.users.history.list.mockResolvedValue({ data: { historyId: "10" } });
    expect(await port.listHistory("4840112")).toEqual({ status: "ok", messages: [], historyId: "4840112" });
  });

  it("turns HTTP 404 into the expired result, on any page", async () => {
    api.users.history.list.mockRejectedValueOnce(httpError("not_found"));
    expect(await port.listHistory("1")).toEqual({ status: "expired" });
    api.users.history.list.mockResolvedValueOnce({ data: historyPage1 }).mockRejectedValueOnce(httpError("not_found"));
    expect(await port.listHistory("1")).toEqual({ status: "expired" });
  });

  it("throws other errors typed", async () => {
    api.users.history.list.mockResolvedValueOnce({ data: historyPage1 }).mockRejectedValueOnce(httpError("server_error"));
    expect(await rejection(port.listHistory("1"))).toBeInstanceOf(GmailTransientError);
    api.users.history.list.mockRejectedValueOnce(httpError("invalid_grant"));
    expect(await rejection(port.listHistory("1"))).toBeInstanceOf(GmailAuthError);
  });

  it("refuses a malformed start id or response", async () => {
    for (const start of ["", "abc", "-1", "1.5", "1".repeat(31)]) {
      expect((await rejection(port.listHistory(start))).reason).toBe("bad_request");
    }
    expect(api.users.history.list).not.toHaveBeenCalled();
    api.users.history.list.mockResolvedValue({ data: { history: [] } });
    expect((await rejection(port.listHistory("1"))).reason).toBe("invalid_response");
  });
});

describe("listInboxAfter", () => {
  it("queries INBOX after the time and pages until the limit", async () => {
    api.users.messages.list.mockResolvedValueOnce({ data: messagesPage1 }).mockResolvedValueOnce({ data: messagesPage2 });
    expect(await port.listInboxAfter(1789369964.9, 50)).toEqual([
      { id: "19207c2d3e4f5066", threadId: "19207c2d3e4f5066" },
      { id: "19206b1c2d3e4f55", threadId: "19206b1c2d3e4f55" },
      { id: "19205a0b1c2d3e44", threadId: "191e8a2f4c0b7d11" },
    ]);
    expect(api.users.messages.list.mock.calls.map(([params]) => params)).toEqual([
      { userId: "me", q: "after:1789369964", labelIds: ["INBOX"], maxResults: 50, pageToken: undefined },
      { userId: "me", q: "after:1789369964", labelIds: ["INBOX"], maxResults: 48, pageToken: messagesPage1.nextPageToken },
    ]);
  });

  it("stops once it has enough and caps the limit at 500", async () => {
    api.users.messages.list.mockResolvedValue({ data: messagesPage1 });
    expect(await port.listInboxAfter(0, 1)).toEqual([{ id: "19207c2d3e4f5066", threadId: "19207c2d3e4f5066" }]);
    expect(api.users.messages.list).toHaveBeenCalledTimes(1);
    api.users.messages.list.mockReset();
    api.users.messages.list.mockResolvedValue({ data: {} });
    expect(await port.listInboxAfter(0, 5000)).toEqual([]);
    expect(api.users.messages.list.mock.calls[0][0].maxResults).toBe(500);
  });

  it("refuses bad arguments without calling Gmail", async () => {
    for (const [after, limit] of [[-1, 10], [Number.NaN, 10], [0, 0], [0, 1.5]]) {
      expect((await rejection(port.listInboxAfter(after, limit))).reason).toBe("bad_request");
    }
    expect(api.users.messages.list).not.toHaveBeenCalled();
  });
});

describe("profile, messages and threads", () => {
  it("reads the profile", async () => {
    api.users.getProfile.mockResolvedValue({ data: profile });
    expect(await port.getProfile()).toEqual({ emailAddress: "creator@example.com", historyId: "4840112" });
    expect(api.users.getProfile).toHaveBeenCalledWith({ userId: "me" });
    api.users.getProfile.mockResolvedValue({ data: { historyId: "1" } });
    expect((await rejection(port.getProfile())).reason).toBe("invalid_response");
  });

  it("gets a message in full format and parses it", async () => {
    api.users.messages.get.mockResolvedValue({ data: nestedMixed });
    expect(await port.getMessage("191f0c6a8e2d4b55")).toEqual(parseGmailMessage(nestedMixed));
    expect(api.users.messages.get).toHaveBeenCalledWith({ userId: "me", id: "191f0c6a8e2d4b55", format: "full" });
  });

  it("maps a missing message and refuses malformed ids", async () => {
    api.users.messages.get.mockRejectedValue(httpError("not_found"));
    expect(await rejection(port.getMessage("191f0c6a8e2d4b55"))).toBeInstanceOf(GmailNotFoundError);
    api.users.messages.get.mockReset();
    for (const id of ["", "has space", "x".repeat(201)]) {
      expect((await rejection(port.getMessage(id))).reason).toBe("bad_request");
      expect((await rejection(port.getThread(id))).reason).toBe("bad_request");
    }
    expect(api.users.messages.get).not.toHaveBeenCalled();
    api.users.messages.get.mockResolvedValue({ data: { snippet: "no ids" } });
    expect((await rejection(port.getMessage("abc"))).reason).toBe("invalid_response");
  });

  it("gets a thread in metadata format, oldest first", async () => {
    api.users.threads.get.mockResolvedValue({ data: threadMetadata });
    const thread = await port.getThread("191e9b7c1a3f5e22");
    expect(api.users.threads.get).toHaveBeenCalledWith({ userId: "me", id: "191e9b7c1a3f5e22", format: "metadata" });
    expect(thread.id).toBe("191e9b7c1a3f5e22");
    expect(thread.messages.map((message) => [message.id, message.labelIds, message.from?.email])).toEqual([
      ["191e9b7c1a3f5e22", ["INBOX", "CATEGORY_PERSONAL"], "marco@keystonevpn.example"],
      ["191ef00a11b2c3d4", ["SENT"], "creator@example.com"],
      ["191f0c6a8e2d4b55", ["INBOX", "IMPORTANT"], "marco@keystonevpn.example"],
    ]);
    expect(thread.messages[0]).toMatchObject({
      messageId: "<keystone-outreach-1@mail.keystonevpn.example>",
      subject: "Sponsorship for your home network videos",
      cc: [{ name: null, email: "scheduling@brightreach.example" }],
      replyTo: [{ name: null, email: "creators@keystonevpn.example" }],
      internalDate: new Date(1789300000000),
    });
    expect(thread.messages[2].references).toEqual([
      "<keystone-outreach-1@mail.keystonevpn.example>",
      "<CAF7x9Q1reply0002@mail.gmail.com>",
    ]);
    expect(thread.messages.every((message) => !("bodyText" in message))).toBe(true);
  });
});

describe("sendReply", () => {
  const input: SendReplyInput = {
    threadId: "191e9b7c1a3f5e22",
    to: ["creators@keystonevpn.example"],
    cc: ["scheduling@brightreach.example"],
    subject: "Re: Sponsorship for your home network videos",
    bodyText: "Hi Marco,\nHappy to do it.",
    inReplyTo: "<keystone-followup-2@mail.keystonevpn.example>",
    references: ["<keystone-outreach-1@mail.keystonevpn.example>", "<CAF7x9Q1reply0002@mail.gmail.com>"],
  };

  it("sends the raw reply into the thread", async () => {
    api.users.messages.send.mockResolvedValue({ data: sendResponse });
    expect(await port.sendReply(input)).toEqual({ id: "19208d3e4f506177", threadId: "191e9b7c1a3f5e22" });
    const [params] = api.users.messages.send.mock.calls[0];
    expect(params.userId).toBe("me");
    expect(params.requestBody.threadId).toBe("191e9b7c1a3f5e22");
    expect(Buffer.from(params.requestBody.raw ?? "", "base64url").toString("utf8")).toBe(buildReplyMessage(input));
  });

  it("refuses bad input before calling Gmail", async () => {
    for (const bad of [{ ...input, threadId: "" }, { ...input, to: ["not an address"] }, { ...input, cc: ["x@y.example\r\nBcc: z@y.example"] }]) {
      const error = await rejection(port.sendReply(bad));
      expect(error.sendOutcome).toBe("not_sent");
    }
    expect(api.users.messages.send).not.toHaveBeenCalled();
  });

  it("marks each failure with whether the reply may have been sent", async () => {
    const outcomes: [unknown, "not_sent" | "unknown"][] = [
      [httpError("invalid_grant"), "not_sent"],
      [httpError("bad_request"), "not_sent"],
      [httpError("rate_limit"), "not_sent"],
      [httpError("not_found"), "not_sent"],
      [httpError("server_error"), "unknown"],
      [networkError("ECONNRESET"), "unknown"],
      [Object.assign(new Error("aborted"), { code: "TimeoutError" }), "unknown"],
    ];
    for (const [thrown, outcome] of outcomes) {
      api.users.messages.send.mockRejectedValueOnce(thrown);
      expect((await rejection(port.sendReply(input))).sendOutcome).toBe(outcome);
    }
  });

  it("reports an unknown outcome when Gmail answers without ids", async () => {
    api.users.messages.send.mockResolvedValue({ data: {} });
    const error = await rejection(port.sendReply(input));
    expect(error.reason).toBe("invalid_response");
    expect(error.sendOutcome).toBe("unknown");
  });
});
