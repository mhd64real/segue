import { randomBytes } from "node:crypto";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every Server Action is a public POST endpoint. This test finds every
// src/app/**/actions.ts module, calls each export as an unauthenticated caller in several
// situations, and requires the unauthorized result (or a redirect to /login) with no
// data access at all. New action modules are covered automatically.

const touched = vi.hoisted(() => {
  const calls: string[] = [];
  const record = (name: string) => calls.push(name);
  const trackedStore = (label: string) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return undefined;
          }
          return async () => {
            record(`${label}.${String(property)}`);
            return undefined;
          };
        },
      },
    );
  return { calls, record, trackedStore, getClaims: vi.fn() };
});

vi.mock("@/lib/store/supabase", () => ({
  createSupabaseStore: () => {
    touched.record("createSupabaseStore");
    return touched.trackedStore("supabaseStore");
  },
}));
vi.mock("@/lib/store/memory", () => ({
  createMemoryStore: () => {
    touched.record("createMemoryStore");
    return touched.trackedStore("memoryStore");
  },
}));
vi.mock("@/lib/demo/store", () => ({
  DEMO_OWNER_EMAIL: "demo@example.com",
  getDemoStore: async () => {
    touched.record("getDemoStore");
    return touched.trackedStore("demoStore");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    touched.record("createAdminClient");
    return touched.trackedStore("adminClient");
  },
  createAdminClientOrNull: () => {
    touched.record("createAdminClientOrNull");
    return touched.trackedStore("adminClient");
  },
}));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => {
    touched.record("supabase-js.createClient");
    return touched.trackedStore("supabaseJsClient");
  },
}));
// The cookie session client may be read: that is how the owner check works.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () =>
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      ? { auth: { getClaims: touched.getClaims } }
      : null,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

type Loader = () => Promise<Record<string, unknown>>;

const appActions = import.meta.glob<Record<string, unknown>>("/src/app/**/actions.ts");
const appSources = import.meta.glob<string>("/src/app/**/actions.ts", { query: "?raw", import: "default" });
const fixtureActions = import.meta.glob<Record<string, unknown>>("/test/fixtures/actions/**/actions.ts");
const fixtureSources = import.meta.glob<string>("/test/fixtures/actions/**/actions.ts", {
  query: "?raw",
  import: "default",
});

const ENV_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ALLOWED_EMAIL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_PUBSUB_TOPIC",
  "PUBSUB_PUSH_AUDIENCE",
  "PUBSUB_PUSH_SERVICE_ACCOUNT",
  "TOKEN_ENCRYPTION_KEY",
  "CRON_SECRET",
  "ANTHROPIC_API_KEY",
  "LLM_MODEL",
  "LLM_MODEL_CLASSIFY",
  "SEGUE_DEMO",
];

const FULL_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  ALLOWED_EMAIL: "owner@example.com",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-secret",
  GOOGLE_PUBSUB_TOPIC: "projects/segue/topics/gmail",
  PUBSUB_PUSH_AUDIENCE: "https://segue.example/api/gmail/push",
  PUBSUB_PUSH_SERVICE_ACCOUNT: "push@segue.iam.gserviceaccount.com",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CRON_SECRET: "0123456789abcdef0123",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

interface Scenario {
  name: string;
  env: Record<string, string>;
  nodeEnv: string;
  claims: unknown;
}

const SCENARIOS: Scenario[] = [
  { name: "no env", env: {}, nodeEnv: "production", claims: { data: null, error: null } },
  { name: "no session", env: FULL_ENV, nodeEnv: "production", claims: { data: null, error: null } },
  {
    name: "invalid session",
    env: FULL_ENV,
    nodeEnv: "production",
    claims: { data: null, error: new Error("invalid JWT") },
  },
  {
    name: "another account",
    env: FULL_ENV,
    nodeEnv: "production",
    claims: { data: { claims: { sub: "user-2", email: "someone@example.com", amr: ["oauth"] } }, error: null },
  },
  {
    name: "allowed email without a Google sign-in",
    env: FULL_ENV,
    nodeEnv: "production",
    claims: {
      data: { claims: { sub: "user-3", email: "owner@example.com", amr: [{ method: "password", timestamp: 1 }] } },
      error: null,
    },
  },
  {
    name: "demo flag outside development",
    env: { ...FULL_ENV, SEGUE_DEMO: "1" },
    nodeEnv: "production",
    claims: { data: null, error: null },
  },
];

const CALL_TIMEOUT_MS = 2000;
const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/;

function applyScenario(scenario: Scenario) {
  for (const name of ENV_NAMES) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(scenario.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("NODE_ENV", scenario.nodeEnv);
  touched.getClaims.mockReset();
  touched.getClaims.mockResolvedValue(scenario.claims);
}

type Outcome = { kind: "value"; value: unknown } | { kind: "error"; error: unknown };

async function call(fn: (...args: unknown[]) => unknown): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "error", error: new Error("timed out") }), CALL_TIMEOUT_MS);
  });
  const run = (async (): Promise<Outcome> => {
    try {
      return { kind: "value", value: await fn() };
    } catch (error) {
      return { kind: "error", error };
    }
  })();
  const outcome = await Promise.race([run, timeout]);
  clearTimeout(timer);
  return outcome;
}

function isUnauthorizedValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    (value as { ok?: unknown }).ok === false &&
    (value as { error?: unknown }).error === "unauthorized"
  );
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.kind === "value") {
    return `returned ${JSON.stringify(outcome.value) ?? "undefined"}`;
  }
  if (isRedirectError(outcome.error)) {
    return `redirected to ${getURLFromRedirectError(outcome.error)}`;
  }
  return `threw ${outcome.error instanceof Error ? outcome.error.name : typeof outcome.error}`;
}

function isAcceptable(outcome: Outcome): boolean {
  if (outcome.kind === "value") {
    return isUnauthorizedValue(outcome.value);
  }
  if (isRedirectError(outcome.error)) {
    const url = getURLFromRedirectError(outcome.error);
    return url === "/login" || url.startsWith("/login?");
  }
  return false;
}

// Returns one line per problem; an empty list means every export fails closed.
async function probeActionModules(modules: Record<string, Loader>, sources: Record<string, () => Promise<string>>) {
  const findings: string[] = [];
  const fetchSpy = vi.fn(async () => new Response(null, { status: 599 }));
  vi.stubGlobal("fetch", fetchSpy);
  try {
    for (const [path, load] of Object.entries(modules)) {
      const source = await sources[path]();
      if (!USE_SERVER.test(source)) {
        findings.push(`${path}: does not start with the "use server" directive`);
      }
      const exports = Object.entries(await load());
      if (exports.length === 0) {
        findings.push(`${path}: exports nothing`);
      }
      for (const [name, value] of exports) {
        if (typeof value !== "function") {
          findings.push(`${path} ${name}: is not a function`);
          continue;
        }
        for (const scenario of SCENARIOS) {
          applyScenario(scenario);
          touched.calls.length = 0;
          fetchSpy.mockClear();
          const outcome = await call(value as (...args: unknown[]) => unknown);
          if (!isAcceptable(outcome)) {
            findings.push(`${path} ${name} (${scenario.name}): ${describeOutcome(outcome)}`);
          }
          if (touched.calls.length > 0) {
            findings.push(`${path} ${name} (${scenario.name}): touched ${[...new Set(touched.calls)].join(", ")}`);
          }
          if (fetchSpy.mock.calls.length > 0) {
            findings.push(`${path} ${name} (${scenario.name}): made a network request`);
          }
        }
      }
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  return findings;
}

function pick<T>(record: Record<string, T>, fragment: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([path]) => path.includes(`/${fragment}/`)));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Server Actions fail closed", () => {
  it("every export of every src/app/**/actions.ts rejects unauthenticated callers without touching data", async () => {
    expect(Object.keys(appSources).sort()).toEqual(Object.keys(appActions).sort());
    expect(Object.keys(appActions)).toContain("/src/app/(dashboard)/videos/actions.ts");
    expect(await probeActionModules(appActions, appSources)).toEqual([]);
  });
});

describe("the action probe itself", () => {
  it("discovers modules in nested and route group folders", () => {
    expect(Object.keys(fixtureActions).length).toBe(6);
    expect(Object.keys(fixtureActions).some((path) => path.includes("/(group)/"))).toBe(true);
  });

  it("accepts actions that check the owner first, by result or by redirect", async () => {
    expect(await probeActionModules(pick(fixtureActions, "good"), pick(fixtureSources, "good"))).toEqual([]);
  });

  it("reports an action that reads the Supabase store without the owner check", async () => {
    const findings = await probeActionModules(
      pick(fixtureActions, "reads-store-directly"),
      pick(fixtureSources, "reads-store-directly"),
    );
    expect(findings.some((line) => line.includes("(no session): touched createAdminClient"))).toBe(true);
    expect(findings.some((line) => line.includes("(no env)") && line.includes("touched"))).toBe(true);
  });

  it("reports an action that uses the demo store without the owner check", async () => {
    const findings = await probeActionModules(
      pick(fixtureActions, "uses-demo-store-directly"),
      pick(fixtureSources, "uses-demo-store-directly"),
    );
    expect(findings.some((line) => line.includes("touched getDemoStore"))).toBe(true);
  });

  it("reports an action that answers before checking the owner", async () => {
    const findings = await probeActionModules(pick(fixtureActions, "validates-first"), pick(fixtureSources, "validates-first"));
    expect(findings.some((line) => line.includes('(no session): returned {"ok":false,"error":"Title is required"}'))).toBe(
      true,
    );
  });

  it("reports an action that calls out to the network without the owner check", async () => {
    const findings = await probeActionModules(pick(fixtureActions, "fetches-directly"), pick(fixtureSources, "fetches-directly"));
    expect(findings.some((line) => line.includes("made a network request"))).toBe(true);
  });

  it("reports a module without the use server directive", async () => {
    const findings = await probeActionModules(
      pick(fixtureActions, "missing-directive"),
      pick(fixtureSources, "missing-directive"),
    );
    expect(findings).toEqual([expect.stringContaining('does not start with the "use server" directive')]);
  });
});
