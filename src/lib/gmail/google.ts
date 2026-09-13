import "server-only";
import { gmail, type GlobalOptions } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { DecryptError, decryptSecret, encryptSecret } from "@/lib/crypto";
import { EnvError, isEnvConfigured, readEnv } from "@/lib/env";
import { createGmailApiPort, type GmailApi, type GmailApiPortOptions } from "@/lib/gmail/api";
import { GmailAuthError, type GmailPort } from "@/lib/gmail/port";
import type { Store } from "@/lib/store/types";

// The real GmailPort: @googleapis/gmail with an OAuth2Client holding the owner's refresh
// token from app_state. Missing env or a missing account is a result, not an exception.
// It does not read needs_reauth: callers decide whether to try Gmail while paused, and set
// the pause themselves on a needs_reauth result or a GmailAuthError.

export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

// Reads (GET) are retried up to twice after a 429 or a 5xx, within about a second. A network
// error or a timeout is retried only as the first retry, so once at most: each such attempt
// can use the whole request timeout. watch, stop and send are POST and are never retried
// here: the caller owns those. Token refreshes do not use this config: google-auth-library
// retries them (POST) up to 3 times after a 408, 429 or 5xx and twice after a network error
// or a timeout, so a call that needs a new access token can wait through 3 timeouts before
// its own request starts (docs/ENGINEERING.md, Gmail layer).
export const GMAIL_RETRY_CONFIG: NonNullable<GlobalOptions["retryConfig"]> = {
  retry: 2,
  retryDelay: 250,
  retryDelayMultiplier: 2,
  maxRetryDelay: 2_000,
  noResponseRetries: 1,
  httpMethodsToRetry: ["GET"],
  statusCodesToRetry: [
    [429, 429],
    [500, 599],
  ],
};

export type GoogleGmailClient =
  | { status: "ready"; gmail: GmailPort; googleEmail: string | null; pubsubTopic: string }
  // missing_env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PUBSUB_TOPIC or
  // TOKEN_ENCRYPTION_KEY is missing or invalid. no_account: nobody has signed in with Google.
  | { status: "not_configured"; reason: "missing_env" | "no_account" }
  // The stored token is missing or unreadable. Callers pause Gmail work as for GmailAuthError.
  | { status: "needs_reauth"; error: GmailAuthError };

export interface GoogleGmailOptions extends GmailApiPortOptions {
  store: Store;
  // Builds the Gmail API client on the OAuth client. Tests pass a mock.
  createApi?: (auth: OAuth2Client) => GmailApi;
  // fetch for every Google request, token refreshes included. Default: the global fetch.
  // Tests pass a mock.
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  // false turns off the retries of reads.
  retry?: boolean;
}

function createDefaultApi(auth: OAuth2Client, timeoutMs: number, retry: boolean): GmailApi {
  return gmail({
    version: "v1",
    auth,
    timeout: timeoutMs,
    retry,
    retryConfig: retry ? GMAIL_RETRY_CONFIG : { retry: 0 },
  });
}

// Runs every port call to the end of any token save it started, so a rotated refresh
// token is stored before the serverless function can finish.
function settleAfterEachCall(port: GmailPort, settle: () => Promise<void>): GmailPort {
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await call(...args);
      } finally {
        await settle();
      }
    };
  return {
    watch: wrap(port.watch),
    stop: wrap(port.stop),
    listHistory: wrap(port.listHistory),
    listInboxAfter: wrap(port.listInboxAfter),
    getProfile: wrap(port.getProfile),
    getMessage: wrap(port.getMessage),
    getThread: wrap(port.getThread),
    sendReply: wrap(port.sendReply),
  };
}

export async function createGoogleGmail(options: GoogleGmailOptions): Promise<GoogleGmailClient> {
  const env = readEnv("google");
  if (!env || !isEnvConfigured("tokenEncryption")) {
    return { status: "not_configured", reason: "missing_env" };
  }
  const { store } = options;
  const state = await store.getAppState();
  if (!state.refreshTokenEnc) {
    return state.googleEmail
      ? { status: "needs_reauth", error: new GmailAuthError("missing_token") }
      : { status: "not_configured", reason: "no_account" };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(state.refreshTokenEnc);
  } catch (error) {
    if (error instanceof EnvError) {
      return { status: "not_configured", reason: "missing_env" };
    }
    if (error instanceof DecryptError) {
      return { status: "needs_reauth", error: new GmailAuthError("unreadable_token") };
    }
    throw error;
  }
  if (!refreshToken) {
    return { status: "needs_reauth", error: new GmailAuthError("missing_token") };
  }

  const timeoutMs = options.timeoutMs ?? GMAIL_REQUEST_TIMEOUT_MS;
  const auth = new OAuth2Client({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    transporterOptions: {
      timeout: timeoutMs,
      // Without one gaxios loads node-fetch, whose timeout error carries no TimeoutError
      // code, so a timeout would map to "network" and a read would not be retried.
      fetchImplementation: options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init)),
    },
  });
  auth.setCredentials({ refresh_token: refreshToken });

  // Google can return a new refresh token with an access token. It replaces the old one
  // in this client right away and in app_state before the call returns.
  let currentToken = refreshToken;
  let storedEnc = state.refreshTokenEnc;
  let pending: Promise<void> = Promise.resolve();

  const persist = async (token: string) => {
    const encrypted = encryptSecret(token);
    const latest = await store.getAppState();
    // A new sign-in stored another token meanwhile. Keep that one.
    if (latest.refreshTokenEnc !== storedEnc) {
      return;
    }
    await store.updateAppState({ refreshTokenEnc: encrypted });
    storedEnc = encrypted;
  };

  auth.on("tokens", (tokens) => {
    const rotated = tokens.refresh_token;
    if (typeof rotated !== "string" || !rotated || rotated === currentToken) {
      return;
    }
    currentToken = rotated;
    // The library copies the refresh token from these credentials into the new ones after
    // this event, so setting it here keeps the rotated token in use.
    auth.setCredentials({ ...auth.credentials, refresh_token: rotated });
    pending = pending
      .then(() => persist(rotated))
      .catch(() => {
        console.error("Could not save the rotated Google refresh token");
      });
  });

  const settle = async () => {
    let seen: Promise<void>;
    do {
      seen = pending;
      await seen;
    } while (seen !== pending);
  };

  const api = options.createApi ? options.createApi(auth) : createDefaultApi(auth, timeoutMs, options.retry ?? true);
  const port = createGmailApiPort(api, options);
  return {
    status: "ready",
    gmail: settleAfterEachCall(port, settle),
    googleEmail: state.googleEmail,
    pubsubTopic: env.pubsubTopic,
  };
}
