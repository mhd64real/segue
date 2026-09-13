import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkEnv, type EnvCheck } from "@/lib/env";
import { describeStoreContract } from "@/lib/store/contract";
import { createSupabaseStore } from "@/lib/store/supabase";
import type { BranchStatus } from "@/lib/store/types";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

// Runs the Store contract against a real Supabase project. Opt in with
// `pnpm test:supabase` (SEGUE_SUPABASE_CONTRACT=1) plus NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY in the environment or .env.local. A requested run with a missing
// or invalid variable fails instead of skipping. It refuses to run against a database
// holding anything but its own tagged rows, deletes those rows after each test, and
// restores app_state at the end.

const TAG_PREFIX = "segue-contract-";
const requested = process.env.SEGUE_SUPABASE_CONTRACT === "1";

if (requested && existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

type ContractRun = { status: "off" } | { status: "blocked"; problem: string } | { status: "ready" };

// Not requested: the contract is skipped. Requested: it runs, or fails with the names
// (never the values) of the variables that are missing or invalid.
function contractRun(isRequested: boolean, env: () => EnvCheck<"supabaseAdmin">): ContractRun {
  if (!isRequested) {
    return { status: "off" };
  }
  const check = env();
  if (check.ok) {
    return { status: "ready" };
  }
  const names = [
    ...check.missing.map((name) => `${name} is missing`),
    ...check.invalid.map((name) => `${name} is invalid`),
  ];
  const detail = names.length > 0 ? names.join(", ") : "the Supabase variables are invalid";
  return { status: "blocked", problem: `SEGUE_SUPABASE_CONTRACT=1 cannot reach Supabase: ${detail}` };
}

type AppStateRow = Database["public"]["Tables"]["app_state"]["Row"];
// Every column but updated_at, which the trigger sets. The type requires each one, so a
// column the suite writes cannot be left out of the reset or the restore.
type AppStateColumns = Omit<AppStateRow, "updated_at">;

const EMPTY_APP_STATE: AppStateColumns = {
  id: true,
  google_email: null,
  refresh_token_enc: null,
  history_id: null,
  watch_expires_at: null,
  last_checked_at: null,
  last_error: null,
  needs_reauth: false,
  llm_paused_reason: null,
};

function appStateColumns(row: AppStateRow): AppStateColumns {
  return {
    id: row.id,
    google_email: row.google_email,
    refresh_token_enc: row.refresh_token_enc,
    history_id: row.history_id,
    watch_expires_at: row.watch_expires_at,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    needs_reauth: row.needs_reauth,
    llm_paused_reason: row.llm_paused_reason,
  };
}

const run = contractRun(requested, () => checkEnv("supabaseAdmin"));
const db: AdminClient | null = run.status === "ready" ? createAdminClient() : null;
const runTag = `${TAG_PREFIX}${Date.now().toString(36)}-`;
// Taken only after the safety checks pass, so a refused run never writes app_state.
let appStateSnapshot: AppStateColumns | null = null;

function fail(step: string, error: { code: string } | null): void {
  if (error) {
    throw new Error(`Supabase contract harness failed to ${step} (code ${error.code})`);
  }
}

async function deleteTaggedRows(client: AdminClient): Promise<void> {
  const pattern = `${TAG_PREFIX}%`;
  fail("delete sponsorships", (await client.from("sponsorships").delete().like("gmail_message_id", pattern)).error);
  fail("delete videos", (await client.from("videos").delete().like("title", pattern)).error);
  fail("delete inbox messages", (await client.from("inbox_messages").delete().like("gmail_message_id", pattern)).error);
}

async function writeAppState(client: AdminClient, step: string, columns: AppStateColumns): Promise<void> {
  fail(step, (await client.from("app_state").upsert(columns, { onConflict: "id" })).error);
}

beforeAll(async () => {
  if (run.status === "blocked") {
    throw new Error(run.problem);
  }
  if (!db) {
    return;
  }
  await deleteTaggedRows(db);
  const pattern = `${TAG_PREFIX}%`;
  const counts = await Promise.all([
    db.from("videos").select("id", { count: "exact", head: true }).not("title", "like", pattern),
    db.from("inbox_messages").select("gmail_message_id", { count: "exact", head: true }).not("gmail_message_id", "like", pattern),
    db.from("sponsorships").select("id", { count: "exact", head: true }).not("gmail_message_id", "like", pattern),
  ]);
  for (const result of counts) {
    fail("count rows", result.error);
    if ((result.count ?? 0) > 0) {
      throw new Error("Refusing to run the Supabase contract: the database holds rows that are not from this suite");
    }
  }
  const { data, error } = await db.from("app_state").select("*").eq("id", true).maybeSingle();
  fail("read app_state", error);
  if (data?.google_email || data?.refresh_token_enc) {
    throw new Error("Refusing to run the Supabase contract: a Google account is connected in app_state");
  }
  // A missing row is what the store creates on first read: an empty one.
  appStateSnapshot = data ? appStateColumns(data) : EMPTY_APP_STATE;
});

afterAll(async () => {
  if (!db) {
    return;
  }
  await deleteTaggedRows(db);
  if (appStateSnapshot) {
    await writeAppState(db, "restore app_state", appStateSnapshot);
  }
});

describe("Supabase contract harness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips only when not requested, and fails a requested run that cannot reach Supabase", () => {
    const unusable = () => {
      throw new Error("the env must not be read when the contract is not requested");
    };
    expect(contractRun(false, unusable)).toEqual({ status: "off" });

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "ftp://private-host.example");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const blocked = contractRun(true, () => checkEnv("supabaseAdmin"));
    expect(blocked.status).toBe("blocked");
    const problem = (blocked as { problem: string }).problem;
    expect(problem).toContain("SUPABASE_SECRET_KEY is missing");
    expect(problem).toContain("NEXT_PUBLIC_SUPABASE_URL is invalid");
    expect(problem).not.toContain("private-host");

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_private-value");
    expect(contractRun(true, () => checkEnv("supabaseAdmin"))).toEqual({ status: "ready" });

    vi.stubEnv("SUPABASE_SECRET_KEY", "has whitespace");
    const invalid = contractRun(true, () => checkEnv("supabaseAdmin"));
    expect(invalid).toEqual({
      status: "blocked",
      problem: "SEGUE_SUPABASE_CONTRACT=1 cannot reach Supabase: SUPABASE_SECRET_KEY is invalid",
    });
  });

  it("restores every app_state column, including the Google account the suite connects", () => {
    const snapshot: AppStateRow = {
      id: true,
      google_email: null,
      refresh_token_enc: null,
      history_id: "4242",
      watch_expires_at: "2026-09-20T06:00:00+00:00",
      last_checked_at: "2026-09-13T06:00:00+00:00",
      last_error: "Gmail sync failed",
      needs_reauth: true,
      llm_paused_reason: "AI paused",
      updated_at: "2026-09-13T06:00:01+00:00",
    };
    const columns = Object.fromEntries(Object.entries(snapshot).filter(([column]) => column !== "updated_at"));

    expect(appStateColumns(snapshot)).toStrictEqual(columns);
    expect(Object.keys(EMPTY_APP_STATE).sort()).toEqual(Object.keys(columns).sort());
    expect(EMPTY_APP_STATE).toMatchObject({ google_email: null, refresh_token_enc: null, needs_reauth: false });
  });
});

describeStoreContract(
  "supabase",
  async () => {
    const client = db as AdminClient;
    await writeAppState(client, "reset app_state", EMPTY_APP_STATE);
    const pattern = `${TAG_PREFIX}%`;
    return {
      store: createSupabaseStore(client),
      tag: runTag,
      now: () => new Date(),
      async expireLeases() {
        const past = new Date(Date.now() - 60_000).toISOString();
        fail(
          "expire inbox leases",
          (
            await client
              .from("inbox_messages")
              .update({ lease_expires_at: past })
              .like("gmail_message_id", pattern)
              .not("lease_expires_at", "is", null)
          ).error,
        );
        fail(
          "expire sponsorship leases",
          (
            await client
              .from("sponsorships")
              .update({ lease_expires_at: past })
              .like("gmail_message_id", pattern)
              .not("lease_expires_at", "is", null)
          ).error,
        );
      },
      async setBranchStatus(branchId: string, status: BranchStatus) {
        const { data, error } = await client.from("branches").select("decided_at").eq("id", branchId).single();
        fail("read branch", error);
        const decidedAt = status === "pending" ? null : (data?.decided_at ?? new Date().toISOString());
        fail(
          "set branch status",
          (await client.from("branches").update({ status, decided_at: decidedAt }).eq("id", branchId)).error,
        );
      },
      async cleanup() {
        await deleteTaggedRows(client);
      },
    };
  },
  { skip: run.status === "off", timeoutMs: 60_000, clockToleranceMs: 30_000 },
);
