import { systemClock, type Clock } from "@/lib/clock";
import {
  createGmailApiPort,
  type ApiListHistoryResponse,
  type ApiListMessagesResponse,
  type ApiThread,
  type GmailApi,
  type GmailApiResponse,
} from "@/lib/gmail/api";
import errorFixtures from "@/lib/gmail/fixtures/errors.json";
import {
  decodeBase64Url,
  decodeBytes,
  decodeHeaderText,
  extractBodyText,
  extractMessageIds,
  getHeader,
  parseAddressList,
  parseContentType,
  parseGmailMessage,
  unfoldHeader,
  type ApiHeader,
  type ApiMessage,
  type ApiMessagePart,
} from "@/lib/gmail/mime";
import {
  GMAIL_INBOX_LABEL,
  GMAIL_SENT_LABEL,
  GMAIL_SPAM_LABEL,
  GMAIL_TRASH_LABEL,
  type EmailAddress,
  type GmailMessage,
  type GmailPort,
} from "@/lib/gmail/port";

// An in-memory Gmail mailbox for tests and demo mode. It serves the Gmail REST calls the
// port makes (same parameters, response shapes and HTTP errors as Google), and the fake
// port runs the same port code as the Google implementation on top of it. Helpers deliver
// mail and inject failures.

export const FAKE_OWNER_EMAIL = "creator@example.com";
export const WATCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_START_HISTORY_ID = BigInt(1000);
const ONE = BigInt(1);
const ZERO = BigInt(0);
const ID_BASE = BigInt("0x1920000000000000");
const ID_STEP = BigInt(4099);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export type FakeGmailMethod =
  | "watch"
  | "stop"
  | "getProfile"
  | "listHistory"
  | "listInboxAfter"
  | "getMessage"
  | "getThread"
  | "sendReply";

// Failures as Gmail reports them. invalid_grant, unauthorized and insufficient_scope surface
// as GmailAuthError; rate_limited, server_error, network and timeout as GmailTransientError;
// not_found as GmailNotFoundError (an expired start id for listHistory); forbidden and
// bad_request as GmailError.
export type FakeGmailFailure =
  | "invalid_grant"
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "not_found"
  | "bad_request"
  | "network"
  | "timeout";

// Thrown the way gaxios reports an HTTP error response.
export class FakeGmailHttpError extends Error {
  readonly status: number;
  readonly response: { status: number; data: unknown };

  constructor(status: number, data: unknown) {
    super(`Request failed with status code ${status}`);
    this.name = "FakeGmailHttpError";
    this.status = status;
    this.response = { status, data };
  }
}

// Thrown the way gaxios reports a request that got no response.
export class FakeGmailNetworkError extends Error {
  readonly code: "ECONNRESET" | "TimeoutError";

  constructor(code: "ECONNRESET" | "TimeoutError") {
    super(code === "TimeoutError" ? "The operation was aborted due to timeout" : "fetch failed");
    this.name = "FakeGmailNetworkError";
    this.code = code;
  }
}

type ErrorFixture = { status: number; body: unknown };

const FAILURE_FIXTURES: Record<Exclude<FakeGmailFailure, "network" | "timeout">, ErrorFixture> = {
  invalid_grant: errorFixtures.invalid_grant,
  unauthorized: errorFixtures.unauthorized,
  insufficient_scope: errorFixtures.insufficient_scope,
  forbidden: errorFixtures.access_not_configured,
  rate_limited: errorFixtures.rate_limit,
  server_error: errorFixtures.server_error,
  not_found: errorFixtures.not_found,
  bad_request: errorFixtures.bad_request,
};

export function fakeGmailFailureError(failure: FakeGmailFailure): Error {
  if (failure === "network") {
    return new FakeGmailNetworkError("ECONNRESET");
  }
  if (failure === "timeout") {
    return new FakeGmailNetworkError("TimeoutError");
  }
  const fixture = FAILURE_FIXTURES[failure];
  return new FakeGmailHttpError(fixture.status, structuredClone(fixture.body));
}

function httpError(fixture: keyof typeof errorFixtures): FakeGmailHttpError {
  const { status, body } = errorFixtures[fixture];
  return new FakeGmailHttpError(status, structuredClone(body));
}

export type FakeAddress = string | { name?: string | null; email: string };

export interface FakeIncomingEmail {
  from: FakeAddress;
  // Defaults to the owner.
  to?: readonly FakeAddress[];
  cc?: readonly FakeAddress[];
  replyTo?: readonly FakeAddress[];
  subject: string;
  // At least one of text and html. Both make a multipart/alternative message.
  text?: string;
  html?: string;
  // Joins this thread. Created when it does not exist yet.
  threadId?: string;
  // Message-ID of a message in the mailbox. The email joins its thread and gets
  // In-Reply-To and References for it.
  inReplyTo?: string;
  // Defaults: SENT for mail from the owner, otherwise INBOX and UNREAD.
  labelIds?: readonly string[];
  // Received time. Defaults to the clock.
  date?: Date;
  messageId?: string;
}

export interface FakeSentReply {
  id: string;
  threadId: string;
  // The thread the request asked for. Gmail starts a new thread when the subject or the
  // reply headers do not match it.
  requestedThreadId: string | null;
  raw: string;
  headers: { name: string; value: string }[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  sentAt: Date;
}

export interface FakeWatchState {
  topicName: string;
  labelIds: string[];
  labelFilterBehavior: string | null;
  expiration: Date;
}

export interface FakePushNotification {
  emailAddress: string;
  historyId: string;
}

export interface FakeGmailOptions {
  clock?: Clock;
  ownerEmail?: string;
  startHistoryId?: number;
  // Caps page sizes below what the caller asks for, to exercise paging.
  maxPageSize?: number;
  // Called like a Pub/Sub push when INBOX changes while a watch is active.
  onPush?: (notification: FakePushNotification) => void;
}

export interface FakeGmail extends GmailPort {
  readonly ownerEmail: string;
  // The Gmail REST calls behind the port, for code that takes a GmailApi.
  readonly api: GmailApi;
  // Port methods in the order they were called.
  readonly calls: readonly FakeGmailMethod[];
  readonly sentReplies: readonly FakeSentReply[];
  deliverEmail(email: FakeIncomingEmail): GmailMessage;
  // Adds a Gmail API message resource (a fixture) as it is, with a new id when its id is taken.
  deliverApiMessage(message: ApiMessage): GmailMessage;
  currentHistoryId(): string;
  watchState(): FakeWatchState | null;
  isWatching(): boolean;
  // Every start id below the current history id now returns HTTP 404.
  expireHistory(): void;
  // The next matching port calls fail. Without a method any call matches.
  failNext(failure: FakeGmailFailure, options?: { method?: FakeGmailMethod; times?: number }): void;
  // The next sends are accepted by Gmail, then the connection drops before the response.
  failNextSendAfterAcceptance(times?: number): void;
  // Every call fails with invalid_grant until restoreAccess.
  revokeAccess(): void;
  restoreAccess(): void;
  clearFailures(): void;
}

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: bigint;
  payload: ApiMessagePart;
  sizeEstimate: number;
  snippet: string;
  messageId: string | null;
}

interface HistoryRecord {
  id: bigint;
  messageId: string;
  threadId: string;
  labelIds: string[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatRfc2822Date(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${DAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function toAddress(value: FakeAddress): { name: string | null; email: string } {
  return typeof value === "string" ? { name: null, email: value } : { name: value.name ?? null, email: value.email };
}

function formatAddress(value: FakeAddress): string {
  const { name, email } = toAddress(value);
  return name ? `"${name.replace(/["\\]/g, "\\$&")}" <${email}>` : email;
}

// "Re:", "Fwd:" and similar prefixes and case do not change the conversation.
function normalizeSubject(subject: string): string {
  let value = subject.replace(/\s+/g, " ").trim();
  let previous: string;
  do {
    previous = value;
    value = value.replace(/^(re|fwd?|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "");
  } while (value !== previous);
  return value.toLowerCase();
}

function clampPageSize(requested: number | undefined, cap: number | undefined): number {
  const size = Math.min(Math.max(requested ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return cap ? Math.min(size, cap) : size;
}

function parsePageToken(token: string | undefined): number {
  if (token === undefined || token === "") {
    return 0;
  }
  if (!/^[0-9]+$/.test(token)) {
    throw httpError("bad_request");
  }
  return Number(token);
}

function parseRawMessage(raw: string): { headers: ApiHeader[]; bodyText: string; contentType: string | null } {
  const text = decodeBase64Url(raw).toString("latin1");
  const split = /\r?\n\r?\n/.exec(text);
  const headerText = split ? text.slice(0, split.index) : text;
  const bodyRaw = split ? text.slice(split.index + split[0].length) : "";
  const lines: string[] = [];
  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += `\r\n${line}`;
    } else {
      lines.push(line);
    }
  }
  const headers: ApiHeader[] = [];
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers.push({ name: line.slice(0, index).trim(), value: unfoldHeader(line.slice(index + 1)).trim() });
    }
  }
  const contentType = getHeader(headers, "Content-Type");
  const encoding = (getHeader(headers, "Content-Transfer-Encoding") ?? "").trim().toLowerCase();
  const bytes = encoding === "base64" ? Buffer.from(bodyRaw.replace(/\s+/g, ""), "base64") : Buffer.from(bodyRaw, "latin1");
  const bodyText = decodeBytes(bytes, parseContentType(contentType).params.charset).replace(/\r\n/g, "\n");
  return { headers, bodyText, contentType };
}

export function createFakeGmail(options: FakeGmailOptions = {}): FakeGmail {
  const clock = options.clock ?? systemClock;
  const ownerEmail = options.ownerEmail ?? FAKE_OWNER_EMAIL;
  const messages = new Map<string, StoredMessage>();
  const threads = new Map<string, string[]>();
  const history: HistoryRecord[] = [];
  const sentReplies: FakeSentReply[] = [];
  const calls: FakeGmailMethod[] = [];
  let historyCounter = options.startHistoryId !== undefined ? BigInt(options.startHistoryId) : DEFAULT_START_HISTORY_ID;
  let oldestValidStart = ZERO;
  let watch: FakeWatchState | null = null;
  let idCounter = 0;
  let messageIdCounter = 0;
  let revoked = false;
  let sendAcceptedFailures = 0;
  const failures: { failure: FakeGmailFailure; method: FakeGmailMethod | null; remaining: number }[] = [];

  const isOwner = (email: string) => email.trim().toLowerCase() === ownerEmail.toLowerCase();

  // 16 hex digits, like Gmail ids.
  const nextId = () => {
    let id: string;
    do {
      idCounter += 1;
      id = (ID_BASE + BigInt(idCounter) * ID_STEP).toString(16);
    } while (messages.has(id) || threads.has(id));
    return id;
  };

  const nextMessageId = () => {
    messageIdCounter += 1;
    return `<fake.${messageIdCounter}.${clock.now().getTime()}@mail.example.com>`;
  };

  const checkFailures = (method: FakeGmailMethod) => {
    if (revoked) {
      throw fakeGmailFailureError("invalid_grant");
    }
    const index = failures.findIndex((entry) => entry.method === null || entry.method === method);
    if (index === -1) {
      return;
    }
    const entry = failures[index];
    entry.remaining -= 1;
    if (entry.remaining <= 0) {
      failures.splice(index, 1);
    }
    throw fakeGmailFailureError(entry.failure);
  };

  const checkUser = (userId: string) => {
    if (userId !== "me" && !isOwner(userId)) {
      throw httpError("bad_request");
    }
  };

  const watchActive = () => watch !== null && watch.expiration.getTime() > clock.now().getTime();

  const addMessage = (input: {
    id?: string | null;
    threadId?: string | null;
    labelIds: readonly string[];
    internalDate: number;
    payload: ApiMessagePart;
  }): StoredMessage => {
    const id = input.id && !messages.has(input.id) ? input.id : nextId();
    const threadId = input.threadId || id;
    historyCounter += ONE;
    const bodyText = extractBodyText(input.payload);
    const stored: StoredMessage = {
      id,
      threadId,
      labelIds: [...new Set(input.labelIds)],
      internalDate: input.internalDate,
      historyId: historyCounter,
      payload: structuredClone(input.payload),
      sizeEstimate: 512 + Buffer.byteLength(JSON.stringify(input.payload)),
      snippet: bodyText.replace(/\s+/g, " ").trim().slice(0, 200),
      messageId: extractMessageIds(getHeader(input.payload.headers, "Message-ID"))[0] ?? null,
    };
    messages.set(id, stored);
    threads.set(threadId, [...(threads.get(threadId) ?? []), id]);
    history.push({ id: historyCounter, messageId: id, threadId, labelIds: [...stored.labelIds] });
    if (stored.labelIds.includes(GMAIL_INBOX_LABEL) && watchActive() && options.onPush) {
      options.onPush({ emailAddress: ownerEmail, historyId: historyCounter.toString() });
    }
    return stored;
  };

  const findByMessageId = (messageId: string) => {
    for (const message of messages.values()) {
      if (message.messageId === messageId) {
        return message;
      }
    }
    return null;
  };

  const formatMessage = (message: StoredMessage, format: string | undefined): ApiMessage => {
    const base: ApiMessage = {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labelIds],
      snippet: message.snippet,
      sizeEstimate: message.sizeEstimate,
      historyId: message.historyId.toString(),
      internalDate: String(message.internalDate),
    };
    const kind = (format ?? "full").toLowerCase();
    if (kind === "minimal") {
      return base;
    }
    if (kind === "metadata") {
      return {
        ...base,
        payload: {
          partId: "",
          mimeType: message.payload.mimeType,
          filename: "",
          headers: structuredClone(message.payload.headers ?? []),
          body: { size: 0 },
        },
      };
    }
    if (kind === "full") {
      return { ...base, payload: structuredClone(message.payload) };
    }
    throw httpError("bad_request");
  };

  const textPart = (partId: string, mimeType: "text/plain" | "text/html", text: string): ApiMessagePart => {
    const bytes = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8");
    return {
      partId,
      mimeType,
      filename: "",
      headers: [
        { name: "Content-Type", value: `${mimeType}; charset="UTF-8"` },
        { name: "Content-Transfer-Encoding", value: "quoted-printable" },
      ],
      body: { size: bytes.length, data: bytes.toString("base64url") },
    };
  };

  const api: GmailApi = {
    users: {
      async watch({ userId, requestBody }) {
        checkFailures("watch");
        checkUser(userId);
        const topicName = requestBody?.topicName ?? "";
        if (!/^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(topicName)) {
          throw httpError("bad_request");
        }
        watch = {
          topicName,
          labelIds: [...(requestBody.labelIds ?? [])],
          labelFilterBehavior: requestBody.labelFilterBehavior ?? null,
          expiration: new Date(clock.now().getTime() + WATCH_DURATION_MS),
        };
        return { data: { historyId: historyCounter.toString(), expiration: String(watch.expiration.getTime()) } };
      },

      async stop({ userId }) {
        checkFailures("stop");
        checkUser(userId);
        watch = null;
        return { data: "" };
      },

      async getProfile({ userId }) {
        checkFailures("getProfile");
        checkUser(userId);
        return {
          data: {
            emailAddress: ownerEmail,
            messagesTotal: messages.size,
            threadsTotal: threads.size,
            historyId: historyCounter.toString(),
          },
        };
      },

      history: {
        async list(params): Promise<GmailApiResponse<ApiListHistoryResponse>> {
          checkFailures("listHistory");
          checkUser(params.userId);
          if (typeof params.startHistoryId !== "string" || !/^[0-9]+$/.test(params.startHistoryId)) {
            throw httpError("bad_request");
          }
          const start = BigInt(params.startHistoryId);
          if (start < oldestValidStart) {
            throw httpError("not_found");
          }
          const types = params.historyTypes;
          const records = history.filter(
            (record) =>
              record.id > start &&
              (!types || types.includes("messageAdded")) &&
              (!params.labelId || record.labelIds.includes(params.labelId)),
          );
          const offset = parsePageToken(params.pageToken);
          const size = clampPageSize(params.maxResults, options.maxPageSize);
          const page = records.slice(offset, offset + size);
          const data: ApiListHistoryResponse = { historyId: historyCounter.toString() };
          if (page.length > 0) {
            data.history = page.map((record) => ({
              id: record.id.toString(),
              messages: [{ id: record.messageId, threadId: record.threadId }],
              messagesAdded: [
                { message: { id: record.messageId, threadId: record.threadId, labelIds: [...record.labelIds] } },
              ],
            }));
          }
          if (offset + size < records.length) {
            data.nextPageToken = String(offset + size);
          }
          return { data };
        },
      },

      messages: {
        async list(params): Promise<GmailApiResponse<ApiListMessagesResponse>> {
          checkFailures("listInboxAfter");
          checkUser(params.userId);
          let afterMs = -Infinity;
          for (const term of (params.q ?? "").split(/\s+/).filter(Boolean)) {
            const match = /^after:([0-9]+)$/.exec(term);
            if (!match) {
              // The fake understands only after:<epoch seconds>.
              throw httpError("bad_request");
            }
            afterMs = Number(match[1]) * 1000;
          }
          const labels = params.labelIds ?? [];
          // The fake includes the boundary second.
          const matching = [...messages.values()]
            .filter(
              (message) =>
                message.internalDate >= afterMs &&
                labels.every((label) => message.labelIds.includes(label)) &&
                !message.labelIds.includes(GMAIL_SPAM_LABEL) &&
                !message.labelIds.includes(GMAIL_TRASH_LABEL),
            )
            .sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? 1 : -1));
          const offset = parsePageToken(params.pageToken);
          const size = clampPageSize(params.maxResults, options.maxPageSize);
          const page = matching.slice(offset, offset + size);
          const data: ApiListMessagesResponse = { resultSizeEstimate: matching.length };
          if (page.length > 0) {
            data.messages = page.map((message) => ({ id: message.id, threadId: message.threadId }));
          }
          if (offset + size < matching.length) {
            data.nextPageToken = String(offset + size);
          }
          return { data };
        },

        async get({ userId, id, format }) {
          checkFailures("getMessage");
          checkUser(userId);
          const message = messages.get(id);
          if (!message) {
            throw httpError("not_found");
          }
          return { data: formatMessage(message, format) };
        },

        async send({ userId, requestBody }) {
          checkFailures("sendReply");
          checkUser(userId);
          if (!requestBody?.raw) {
            throw httpError("bad_request");
          }
          const parsed = parseRawMessage(requestBody.raw);
          const to = parseAddressList(getHeader(parsed.headers, "To"));
          const cc = parseAddressList(getHeader(parsed.headers, "Cc"));
          const bcc = parseAddressList(getHeader(parsed.headers, "Bcc"));
          if (to.length + cc.length + bcc.length === 0) {
            throw httpError("bad_request");
          }
          const requestedThreadId = requestBody.threadId ?? null;
          if (requestedThreadId !== null && !threads.has(requestedThreadId)) {
            throw httpError("not_found");
          }
          const subject = decodeHeaderText(getHeader(parsed.headers, "Subject"));
          const inReplyTo = extractMessageIds(getHeader(parsed.headers, "In-Reply-To"))[0] ?? null;
          const references = extractMessageIds(getHeader(parsed.headers, "References"));

          let threadId: string | null = null;
          if (requestedThreadId !== null) {
            const threadMessages = (threads.get(requestedThreadId) ?? []).map((id) => messages.get(id)!);
            const threadIds = new Set(threadMessages.map((message) => message.messageId).filter(Boolean));
            const first = threadMessages[0];
            const firstSubject = first ? decodeHeaderText(getHeader(first.payload.headers, "Subject")) : "";
            const headersMatch = [inReplyTo, ...references].some((id) => id !== null && threadIds.has(id));
            if (headersMatch && normalizeSubject(firstSubject) === normalizeSubject(subject)) {
              threadId = requestedThreadId;
            }
          }

          const now = clock.now();
          const messageId = nextMessageId();
          const headers: ApiHeader[] = [
            { name: "MIME-Version", value: "1.0" },
            { name: "Date", value: formatRfc2822Date(now) },
            { name: "Message-ID", value: messageId },
            { name: "From", value: ownerEmail },
            ...parsed.headers.filter((header) => !/^(mime-version|date|message-id|from|bcc)$/i.test(header.name ?? "")),
          ];
          const labels = [GMAIL_SENT_LABEL];
          if ([...to, ...cc, ...bcc].some((address) => isOwner(address.email))) {
            labels.push(GMAIL_INBOX_LABEL);
          }
          const bodyPart = textPart("", "text/plain", parsed.bodyText);
          const stored = addMessage({
            threadId,
            labelIds: labels,
            internalDate: now.getTime(),
            payload: { ...bodyPart, headers },
          });
          sentReplies.push({
            id: stored.id,
            threadId: stored.threadId,
            requestedThreadId,
            raw: requestBody.raw,
            headers: parsed.headers.map((header) => ({ name: header.name ?? "", value: header.value ?? "" })),
            to,
            cc,
            subject,
            inReplyTo,
            references,
            bodyText: parsed.bodyText,
            sentAt: now,
          });
          if (sendAcceptedFailures > 0) {
            sendAcceptedFailures -= 1;
            throw new FakeGmailNetworkError("ECONNRESET");
          }
          return { data: { id: stored.id, threadId: stored.threadId, labelIds: [...stored.labelIds] } };
        },
      },

      threads: {
        async get({ userId, id, format }): Promise<GmailApiResponse<ApiThread>> {
          checkFailures("getThread");
          checkUser(userId);
          const ids = threads.get(id);
          if (!ids) {
            throw httpError("not_found");
          }
          const threadMessages = ids
            .map((messageId) => messages.get(messageId)!)
            .sort((a, b) => a.internalDate - b.internalDate);
          const historyId = threadMessages.reduce((max, message) => (message.historyId > max ? message.historyId : max), ZERO);
          return {
            data: {
              id,
              historyId: historyId.toString(),
              messages: threadMessages.map((message) => formatMessage(message, format)),
            },
          };
        },
      },
    },
  };

  const port = createGmailApiPort(api);
  const record =
    <A extends unknown[], R>(method: FakeGmailMethod, call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push(method);
      return call(...args);
    };

  const deliverEmail = (email: FakeIncomingEmail): GmailMessage => {
    if (email.text === undefined && email.html === undefined) {
      throw new TypeError("deliverEmail needs text or html");
    }
    const date = email.date ?? clock.now();
    const replied = email.inReplyTo ? findByMessageId(email.inReplyTo) : null;
    const threadId = email.threadId ?? replied?.threadId ?? null;
    const messageId = email.messageId ?? nextMessageId();
    const from = toAddress(email.from);
    const headers: ApiHeader[] = [
      { name: "Delivered-To", value: ownerEmail },
      { name: "MIME-Version", value: "1.0" },
      { name: "Date", value: formatRfc2822Date(date) },
      { name: "Message-ID", value: messageId },
    ];
    if (replied?.messageId) {
      const references = [
        ...extractMessageIds(getHeader(replied.payload.headers, "References")),
        replied.messageId,
      ];
      headers.push({ name: "In-Reply-To", value: replied.messageId }, { name: "References", value: references.join(" ") });
    }
    headers.push({ name: "Subject", value: email.subject }, { name: "From", value: formatAddress(from) });
    headers.push({ name: "To", value: (email.to ?? [ownerEmail]).map(formatAddress).join(", ") });
    if (email.cc && email.cc.length > 0) {
      headers.push({ name: "Cc", value: email.cc.map(formatAddress).join(", ") });
    }
    if (email.replyTo && email.replyTo.length > 0) {
      headers.push({ name: "Reply-To", value: email.replyTo.map(formatAddress).join(", ") });
    }

    let payload: ApiMessagePart;
    if (email.text !== undefined && email.html !== undefined) {
      const boundary = `fake-boundary-${messageIdCounter}`;
      payload = {
        partId: "",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [...headers, { name: "Content-Type", value: `multipart/alternative; boundary="${boundary}"` }],
        body: { size: 0 },
        parts: [textPart("0", "text/plain", email.text), textPart("1", "text/html", email.html)],
      };
    } else {
      const part = email.text !== undefined ? textPart("", "text/plain", email.text) : textPart("", "text/html", email.html!);
      payload = { ...part, headers: [...headers, ...(part.headers ?? [])] };
    }
    const labelIds = email.labelIds ?? (isOwner(from.email) ? [GMAIL_SENT_LABEL] : [GMAIL_INBOX_LABEL, "UNREAD"]);
    const stored = addMessage({ threadId, labelIds, internalDate: date.getTime(), payload });
    return parseGmailMessage(formatMessage(stored, "full"));
  };

  const deliverApiMessage = (message: ApiMessage): GmailMessage => {
    const internal = Number(message.internalDate);
    const stored = addMessage({
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds ?? [GMAIL_INBOX_LABEL],
      internalDate: Number.isFinite(internal) ? internal : clock.now().getTime(),
      payload: message.payload ?? { mimeType: "text/plain", headers: [], body: { size: 0 } },
    });
    return parseGmailMessage(formatMessage(stored, "full"));
  };

  return {
    ownerEmail,
    api,
    calls,
    sentReplies,
    watch: record("watch", port.watch),
    stop: record("stop", port.stop),
    listHistory: record("listHistory", port.listHistory),
    listInboxAfter: record("listInboxAfter", port.listInboxAfter),
    getProfile: record("getProfile", port.getProfile),
    getMessage: record("getMessage", port.getMessage),
    getThread: record("getThread", port.getThread),
    sendReply: record("sendReply", port.sendReply),
    deliverEmail,
    deliverApiMessage,
    currentHistoryId: () => historyCounter.toString(),
    watchState: () => (watch ? structuredClone(watch) : null),
    isWatching: watchActive,
    expireHistory() {
      oldestValidStart = historyCounter;
    },
    failNext(failure, failOptions = {}) {
      const times = failOptions.times ?? 1;
      if (times > 0) {
        failures.push({ failure, method: failOptions.method ?? null, remaining: times });
      }
    },
    failNextSendAfterAcceptance(times = 1) {
      sendAcceptedFailures += Math.max(0, times);
    },
    revokeAccess() {
      revoked = true;
    },
    restoreAccess() {
      revoked = false;
    },
    clearFailures() {
      failures.length = 0;
      sendAcceptedFailures = 0;
      revoked = false;
    },
  };
}
