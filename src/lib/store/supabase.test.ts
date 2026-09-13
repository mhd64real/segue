import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseStore } from "@/lib/store/supabase";
import { LEASE_SECONDS, MAX_ATTEMPTS, StoreError } from "@/lib/store/types";
import type { Database } from "@/lib/supabase/database.types";

// Offline checks of the PostgREST adapter: request shapes, row mapping and error
// mapping. Behavior against a real database is covered by the contract suite.

interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}

type Reply = { status: number; body?: unknown } | Error;

function fakeClient(reply: (request: Recorded) => Reply) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const recorded = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    const result = reply(recorded);
    if (result instanceof Error) {
      throw result;
    }
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createClient<Database>("http://supabase.test", "sb_secret_test", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    // postgrest-js retries idempotent reads after network errors with backoff; skip the wait here.
    db: { retry: false },
    global: { fetch: fetchImpl },
  });
  return { store: createSupabaseStore(client), requests };
}

const SECRET_TEXT = "private email text from the sponsor";
const VIDEO_ID = "11111111-1111-4111-8111-111111111111";

const inboxRow = {
  gmail_message_id: "msg-1",
  status: "pending",
  attempts: 1,
  lease_expires_at: "2026-09-13T10:10:00.123456+00:00",
  error: null,
  input_tokens: 0,
  output_tokens: 0,
  created_at: "2026-09-13T10:00:00+00:00",
  updated_at: "2026-09-13T10:00:00.5+00:00",
};

async function catchStoreError(promise: Promise<unknown>): Promise<StoreError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StoreError);
  return error as StoreError;
}

describe("Supabase store adapter", () => {
  it("returns null for ids that are not UUIDs without calling the database", async () => {
    const { store, requests } = fakeClient(() => ({ status: 500 }));
    expect(await store.getVideo("../etc")).toBeNull();
    expect(await store.getBranch("1 or 1=1")).toBeNull();
    expect(await store.deleteVideo("nope")).toBe("not_found");
    expect(await store.claimDraftSend("nope")).toBeNull();
    expect(await store.markNotificationsRead(["nope"])).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("calls the claim function with the lease and attempt limits and maps dates", async () => {
    const { store, requests } = fakeClient(() => ({ status: 200, body: [inboxRow] }));
    const claimed = await store.claimInboxMessage("msg-1");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url.pathname).toBe("/rest/v1/rpc/claim_inbox_message");
    expect(requests[0].body).toEqual({
      p_gmail_message_id: "msg-1",
      p_lease_seconds: LEASE_SECONDS,
      p_max_attempts: MAX_ATTEMPTS,
    });
    expect(claimed).toEqual({
      gmailMessageId: "msg-1",
      status: "pending",
      attempts: 1,
      leaseExpiresAt: new Date("2026-09-13T10:10:00.123Z"),
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: new Date("2026-09-13T10:00:00.000Z"),
      updatedAt: new Date("2026-09-13T10:00:00.500Z"),
    });

    await store.claimNextInboxMessage();
    expect(requests[1].body).toEqual({ p_lease_seconds: LEASE_SECONDS, p_max_attempts: MAX_ATTEMPTS });
  });

  it("sends a refund flag, a clamped error and whole token counts on release", async () => {
    const { store, requests } = fakeClient(() => ({ status: 200, body: [] }));
    expect(
      await store.releaseInboxMessage("msg-1", {
        reason: "account",
        error: "e".repeat(700),
        usage: { inputTokens: 12.7, outputTokens: -4 },
      }),
    ).toBeNull();
    expect(requests[0].body).toEqual({
      p_gmail_message_id: "msg-1",
      p_refund_attempt: true,
      p_max_attempts: MAX_ATTEMPTS,
      p_error: "e".repeat(500),
      p_input_tokens: 12,
      p_output_tokens: 0,
    });
  });

  it("maps check violations to invalid_input without copying database text", async () => {
    const { store } = fakeClient(() => ({
      status: 400,
      body: {
        code: "23514",
        message: `new row violates check constraint: ${SECRET_TEXT}`,
        details: `Failing row contains (${SECRET_TEXT})`,
        hint: null,
      },
    }));
    const error = await catchStoreError(store.updateAppState({ lastError: "Sync failed" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toBe("Invalid input in updateAppState");
    expect(JSON.stringify({ message: error.message, cause: error.cause })).not.toContain(SECRET_TEXT);
    expect(error.cause).toEqual({ code: "23514" });
  });

  it("maps other failures, including network errors, to database errors", async () => {
    const serverError = fakeClient(() => ({
      status: 500,
      body: { code: "XX000", message: SECRET_TEXT, details: SECRET_TEXT, hint: null },
    }));
    const error = await catchStoreError(serverError.store.getVideo(VIDEO_ID));
    expect(error.code).toBe("database");
    expect(error.message).toBe("Database error in getVideo");
    expect(error.message).not.toContain(SECRET_TEXT);

    const offline = fakeClient(() => new TypeError("fetch failed"));
    const networkError = await catchStoreError(offline.store.listVideos());
    expect(networkError.code).toBe("database");
    expect(networkError.message).toBe("Database error in listVideos");
  });

  it("reports a missing video from a foreign key violation on completeMatch", async () => {
    const { store, requests } = fakeClient(() => ({
      status: 409,
      body: { code: "23503", message: "violates foreign key constraint", details: null, hint: null },
    }));
    const result = await store.completeMatch(VIDEO_ID, {
      videoId: "22222222-2222-4222-8222-222222222222",
      fitReason: "Fits",
    });
    expect(result).toEqual({ status: "video_missing" });
    expect(requests[0].url.pathname).toBe("/rest/v1/rpc/settle_sponsorship");
    expect(requests[0].body).toMatchObject({
      p_id: VIDEO_ID,
      p_from: "matching",
      p_to: "writing",
      p_video_id: "22222222-2222-4222-8222-222222222222",
      p_fit_reason: "Fits",
      p_input_tokens: 0,
      p_output_tokens: 0,
    });
  });

  it("rejects invalid input before any request", async () => {
    const { store, requests } = fakeClient(() => ({ status: 500 }));
    expect((await catchStoreError(store.createVideo({ title: "", script: "" }))).code).toBe("invalid_input");
    expect((await catchStoreError(store.advanceHistoryId("abc"))).code).toBe("invalid_input");
    expect((await catchStoreError(store.insertInboxMessages(["x".repeat(201)]))).code).toBe("invalid_input");
    expect(requests).toHaveLength(0);
  });

  it("checks for a sending or sent reply through the video's branches with one row at most", async () => {
    const { store, requests } = fakeClient((request) => ({
      status: 200,
      body: request.url.searchParams.get("branches.video_id") === `eq.${VIDEO_ID}` ? [{ id: "d", branches: { video_id: VIDEO_ID } }] : [],
    }));
    expect(await store.hasSendingOrSentReply(VIDEO_ID)).toBe(true);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url.pathname).toBe("/rest/v1/email_drafts");
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      select: "id,branches!inner(video_id)",
      "branches.video_id": `eq.${VIDEO_ID}`,
      status: "in.(sending,sent)",
      limit: "1",
    });
    expect(await store.hasSendingOrSentReply("22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(await store.hasSendingOrSentReply("nope")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("rejects an unexpected delete_video result", async () => {
    const { store } = fakeClient(() => ({ status: 200, body: "something else" }));
    expect((await catchStoreError(store.deleteVideo(VIDEO_ID))).code).toBe("database");
  });
});
