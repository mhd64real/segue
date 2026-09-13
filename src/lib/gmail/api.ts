import { parseGmailMessage, parseMessageSummary, type ApiMessage } from "@/lib/gmail/mime";
import {
  GMAIL_INBOX_LABEL,
  GmailAuthError,
  GmailError,
  GmailNotFoundError,
  GmailTransientError,
  withSendOutcome,
  type GmailAddedMessage,
  type GmailMessageRef,
  type GmailPort,
  type SendOutcome,
} from "@/lib/gmail/port";
import { buildReplyRaw } from "@/lib/gmail/reply";

// GmailPort on top of the Gmail REST API. `GmailApi` is the part of the @googleapis/gmail
// client this uses, typed structurally so the in-memory fake can serve the same calls.
// Errors are read by shape (status, response body, error code), which covers gaxios errors
// from the real client and the fake's errors alike.

export interface GmailApiResponse<T> {
  data: T;
}

export interface ApiWatchRequest {
  topicName?: string | null;
  labelIds?: string[] | null;
  labelFilterBehavior?: string | null;
}

export interface ApiWatchResponse {
  historyId?: string | null;
  expiration?: string | null;
}

export interface ApiProfile {
  emailAddress?: string | null;
  historyId?: string | null;
  messagesTotal?: number | null;
  threadsTotal?: number | null;
}

export interface ApiHistoryRecord {
  id?: string | null;
  messages?: ApiMessage[];
  messagesAdded?: { message?: ApiMessage }[];
}

export interface ApiListHistoryResponse {
  history?: ApiHistoryRecord[];
  historyId?: string | null;
  nextPageToken?: string | null;
}

export interface ApiListMessagesResponse {
  messages?: ApiMessage[];
  nextPageToken?: string | null;
  resultSizeEstimate?: number | null;
}

export interface ApiThread {
  id?: string | null;
  historyId?: string | null;
  snippet?: string | null;
  messages?: ApiMessage[];
}

export interface GmailApi {
  users: {
    watch(params: { userId: string; requestBody: ApiWatchRequest }): Promise<GmailApiResponse<ApiWatchResponse>>;
    stop(params: { userId: string }): Promise<unknown>;
    getProfile(params: { userId: string }): Promise<GmailApiResponse<ApiProfile>>;
    history: {
      list(params: {
        userId: string;
        startHistoryId: string;
        historyTypes?: string[];
        labelId?: string;
        maxResults?: number;
        pageToken?: string;
      }): Promise<GmailApiResponse<ApiListHistoryResponse>>;
    };
    messages: {
      list(params: {
        userId: string;
        q?: string;
        labelIds?: string[];
        maxResults?: number;
        pageToken?: string;
      }): Promise<GmailApiResponse<ApiListMessagesResponse>>;
      get(params: { userId: string; id: string; format?: string }): Promise<GmailApiResponse<ApiMessage>>;
      send(params: { userId: string; requestBody: { threadId?: string; raw?: string } }): Promise<GmailApiResponse<ApiMessage>>;
    };
    threads: {
      get(params: { userId: string; id: string; format?: string }): Promise<GmailApiResponse<ApiThread>>;
    };
  };
}

export interface GmailApiPortOptions {
  // Records per history page (Gmail allows up to 500).
  historyPageSize?: number;
  // Pages read in one listHistory call. When more remain, the result stops at the last
  // record read and the next call continues from there.
  maxHistoryPages?: number;
}

const USER = "me";
export const DEFAULT_HISTORY_PAGE_SIZE = 500;
export const DEFAULT_MAX_HISTORY_PAGES = 20;
export const LIST_INBOX_MAX = 500;
const ID_MAX_LENGTH = 200;

// Error mapping

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null ? (value as Json) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const TIMEOUT_CODES = new Set([
  "TimeoutError",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_CODES = new Set([
  "AbortError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "concurrentLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "authError"]);

// Error codes and names along the cause chain (gaxios wraps fetch errors, which wrap
// socket errors).
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = asRecord(current);
    if (!record) {
      break;
    }
    if (typeof record.code === "string") {
      codes.push(record.code);
    }
    if (typeof record.name === "string") {
      codes.push(record.name);
    }
    current = record.cause;
  }
  return codes;
}

// Reasons from a Google API error body: error.errors[].reason, error.details[].reason and
// error.status.
function apiErrorReasons(data: unknown): string[] {
  const error = asRecord(asRecord(data)?.error);
  if (!error) {
    return [];
  }
  const reasons: string[] = [];
  for (const list of [error.errors, error.details]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        const reason = asRecord(item)?.reason;
        if (typeof reason === "string") {
          reasons.push(reason);
        }
      }
    }
  }
  if (typeof error.status === "string") {
    reasons.push(error.status);
  }
  return reasons;
}

// Maps anything thrown by a Gmail or Google OAuth request to a typed GmailError. The
// original error is not kept as a cause: it can hold request headers and bodies.
export function toGmailError(error: unknown): GmailError {
  if (error instanceof GmailError) {
    return error;
  }
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const status = asNumber(response?.status) ?? asNumber(record?.status);
  const data = response?.data;

  if (status === null) {
    const codes = errorCodes(error);
    if (codes.some((code) => TIMEOUT_CODES.has(code))) {
      return new GmailTransientError("timeout");
    }
    // A gaxios error without a response never reached Gmail (it carries its request config).
    if (codes.some((code) => NETWORK_CODES.has(code)) || (record && "config" in record)) {
      return new GmailTransientError("network");
    }
    return new GmailError("unexpected");
  }

  // Google OAuth token endpoint errors: { error: "invalid_grant", error_description }.
  const oauthError = asRecord(data)?.error;
  if (typeof oauthError === "string") {
    if (oauthError === "invalid_grant") {
      return new GmailAuthError("invalid_grant", { status });
    }
    if (oauthError === "invalid_client" || oauthError === "unauthorized_client") {
      return new GmailAuthError("client_rejected", { status });
    }
    if (oauthError === "invalid_scope") {
      return new GmailAuthError("insufficient_scope", { status });
    }
  }

  const reasons = apiErrorReasons(data);
  if (status === 401) {
    return new GmailAuthError("unauthorized", { status });
  }
  if (status === 403) {
    if (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))) {
      return new GmailTransientError("rate_limited", { status });
    }
    if (reasons.some((reason) => SCOPE_REASONS.has(reason))) {
      return new GmailAuthError("insufficient_scope", { status });
    }
    return new GmailError("forbidden", { status });
  }
  if (status === 404) {
    return new GmailNotFoundError({ status });
  }
  if (status === 408) {
    return new GmailTransientError("timeout", { status });
  }
  if (status === 429) {
    return new GmailTransientError("rate_limited", { status });
  }
  if (status >= 500 && status <= 599) {
    return new GmailTransientError("server_error", { status });
  }
  if (status === 400) {
    return new GmailError("bad_request", { status });
  }
  return new GmailError("unexpected", { status });
}

// Whether Gmail may have accepted a send that failed with this error.
export function sendOutcomeFor(error: GmailError): SendOutcome {
  if (error instanceof GmailAuthError || error instanceof GmailNotFoundError) {
    return "not_sent";
  }
  if (error.status !== null && error.status >= 400 && error.status < 500) {
    return "not_sent";
  }
  if (error.reason === "invalid_recipient" || error.reason === "invalid_reply" || error.reason === "bad_request") {
    return "not_sent";
  }
  return "unknown";
}

async function request<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toGmailError(error);
  }
}

// Validation of inputs and responses

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_MAX_LENGTH || /\s/.test(value)) {
    throw new GmailError("bad_request");
  }
  return value;
}

function isHistoryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,30}$/.test(value);
}

function responseHistoryId(value: unknown): string {
  if (!isHistoryId(value)) {
    throw new GmailError("invalid_response");
  }
  return value;
}

function maxHistoryId(a: string, b: string): string {
  return BigInt(b) > BigInt(a) ? b : a;
}

export function createGmailApiPort(api: GmailApi, options: GmailApiPortOptions = {}): GmailPort {
  const pageSize = Math.min(Math.max(options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE, 1), 500);
  const maxPages = Math.max(options.maxHistoryPages ?? DEFAULT_MAX_HISTORY_PAGES, 1);

  return {
    async watch(topicName) {
      if (typeof topicName !== "string" || !/^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(topicName)) {
        throw new GmailError("bad_request");
      }
      const { data } = await request(() =>
        api.users.watch({
          userId: USER,
          requestBody: { topicName, labelIds: [GMAIL_INBOX_LABEL], labelFilterBehavior: "INCLUDE" },
        }),
      );
      const expiration = Number(data?.expiration);
      if (!Number.isFinite(expiration) || expiration <= 0) {
        throw new GmailError("invalid_response");
      }
      return { historyId: responseHistoryId(data?.historyId), expiration: new Date(expiration) };
    },

    async stop() {
      await request(() => api.users.stop({ userId: USER }));
    },

    async listHistory(startHistoryId) {
      if (!isHistoryId(startHistoryId)) {
        throw new GmailError("bad_request");
      }
      const messages = new Map<string, GmailAddedMessage>();
      let historyId = startHistoryId;
      let lastRecordId: string | null = null;
      let pageToken: string | undefined;
      for (let page = 1; ; page += 1) {
        let data: ApiListHistoryResponse;
        try {
          ({ data } = await api.users.history.list({
            userId: USER,
            startHistoryId,
            historyTypes: ["messageAdded"],
            labelId: GMAIL_INBOX_LABEL,
            maxResults: pageSize,
            pageToken,
          }));
        } catch (error) {
          const mapped = toGmailError(error);
          if (mapped instanceof GmailNotFoundError) {
            return { status: "expired" };
          }
          throw mapped;
        }
        for (const record of data?.history ?? []) {
          if (isHistoryId(record.id)) {
            lastRecordId = lastRecordId ? maxHistoryId(lastRecordId, record.id) : record.id;
          }
          for (const added of record.messagesAdded ?? []) {
            const message = added.message;
            if (message?.id && message.threadId && !messages.has(message.id)) {
              messages.set(message.id, {
                id: message.id,
                threadId: message.threadId,
                labelIds: [...(message.labelIds ?? [])],
              });
            }
          }
        }
        historyId = maxHistoryId(historyId, responseHistoryId(data?.historyId));
        pageToken = data?.nextPageToken || undefined;
        if (!pageToken) {
          return { status: "ok", messages: [...messages.values()], historyId };
        }
        if (page >= maxPages) {
          // Continue next time from the last record read, so nothing after it is skipped.
          return { status: "ok", messages: [...messages.values()], historyId: lastRecordId ?? startHistoryId };
        }
      }
    },

    async listInboxAfter(afterEpochSeconds, limit) {
      if (!Number.isFinite(afterEpochSeconds) || afterEpochSeconds < 0 || !Number.isInteger(limit) || limit < 1) {
        throw new GmailError("bad_request");
      }
      const wanted = Math.min(limit, LIST_INBOX_MAX);
      const refs: GmailMessageRef[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      do {
        const { data } = await request(() =>
          api.users.messages.list({
            userId: USER,
            q: `after:${Math.floor(afterEpochSeconds)}`,
            labelIds: [GMAIL_INBOX_LABEL],
            maxResults: wanted - refs.length,
            pageToken,
          }),
        );
        for (const message of data?.messages ?? []) {
          if (message.id && message.threadId && !seen.has(message.id) && refs.length < wanted) {
            seen.add(message.id);
            refs.push({ id: message.id, threadId: message.threadId });
          }
        }
        pageToken = data?.nextPageToken || undefined;
      } while (pageToken && refs.length < wanted);
      return refs;
    },

    async getProfile() {
      const { data } = await request(() => api.users.getProfile({ userId: USER }));
      if (typeof data?.emailAddress !== "string" || !data.emailAddress) {
        throw new GmailError("invalid_response");
      }
      return { emailAddress: data.emailAddress, historyId: responseHistoryId(data.historyId) };
    },

    async getMessage(id) {
      const messageId = requireId(id);
      const { data } = await request(() => api.users.messages.get({ userId: USER, id: messageId, format: "full" }));
      return parseGmailMessage(data ?? {});
    },

    async getThread(threadId) {
      const id = requireId(threadId);
      // Metadata format: every header, no bodies.
      const { data } = await request(() => api.users.threads.get({ userId: USER, id, format: "metadata" }));
      const messages = (data?.messages ?? [])
        .map((message) => parseMessageSummary(message))
        .map((message, index) => ({ message, index }))
        .sort((a, b) => a.message.internalDate.getTime() - b.message.internalDate.getTime() || a.index - b.index)
        .map(({ message }) => message);
      return { id: data?.id || id, messages };
    },

    async sendReply(input) {
      let threadId: string;
      let raw: string;
      try {
        threadId = requireId(input.threadId);
        raw = buildReplyRaw(input);
      } catch (error) {
        throw withSendOutcome(toGmailError(error), "not_sent");
      }
      let data: ApiMessage;
      try {
        ({ data } = await api.users.messages.send({ userId: USER, requestBody: { threadId, raw } }));
      } catch (error) {
        const mapped = toGmailError(error);
        throw withSendOutcome(mapped, sendOutcomeFor(mapped));
      }
      if (!data?.id || !data.threadId) {
        // Gmail answered with success, so the reply was most likely sent.
        throw new GmailError("invalid_response", { sendOutcome: "unknown" });
      }
      return { id: data.id, threadId: data.threadId };
    },
  };
}
