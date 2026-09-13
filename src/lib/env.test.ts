import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  ENV_GROUP_NAMES,
  EnvError,
  InvalidEnvError,
  MissingEnvError,
  checkEnv,
  isEnvConfigured,
  readEnv,
  requireEnv,
} from "@/lib/env";

const ALL_VARIABLES = [
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
];

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  for (const name of ALL_VARIABLES) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with no env vars", () => {
  it("throws MissingEnvError naming every missing variable of the group", () => {
    const error = catchError(() => requireEnv("supabaseAdmin"));
    expect(error).toBeInstanceOf(MissingEnvError);
    expect(error).toBeInstanceOf(EnvError);
    const envError = error as MissingEnvError;
    expect(envError.group).toBe("supabaseAdmin");
    expect(envError.variables).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
    expect(envError.message).toBe(
      "Missing environment variables for supabaseAdmin: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY",
    );
  });

  it("names the variables of each required group", () => {
    const expected: Record<string, string[]> = {
      supabasePublic: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
      supabaseAdmin: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"],
      owner: ["ALLOWED_EMAIL"],
      google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PUBSUB_TOPIC"],
      pubsub: ["PUBSUB_PUSH_AUDIENCE", "PUBSUB_PUSH_SERVICE_ACCOUNT"],
      tokenEncryption: ["TOKEN_ENCRYPTION_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      cron: ["CRON_SECRET"],
    };
    for (const group of ENV_GROUP_NAMES) {
      if (group === "llm") {
        continue;
      }
      const error = catchError(() => requireEnv(group)) as MissingEnvError;
      expect(error).toBeInstanceOf(MissingEnvError);
      expect(error.variables).toEqual(expected[group]);
      expect(readEnv(group)).toBeNull();
      expect(isEnvConfigured(group)).toBe(false);
    }
  });

  it("gives the llm group its defaults", () => {
    expect(requireEnv("llm")).toEqual({ model: DEFAULT_LLM_MODEL, classifyModel: DEFAULT_LLM_MODEL });
    expect(DEFAULT_LLM_MODEL).toBe("claude-opus-5");
  });

  it("treats empty and whitespace-only values as missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "   ");
    const error = catchError(() => requireEnv("supabaseAdmin")) as MissingEnvError;
    expect(error).toBeInstanceOf(MissingEnvError);
    expect(error.variables).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  });
});

describe("reading values", () => {
  it("reads lazily, so later changes are seen", () => {
    expect(readEnv("supabasePublic")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://tzkvqtcczbwioevojejm.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", " sb_publishable_abc \n");
    expect(requireEnv("supabasePublic")).toEqual({
      url: "https://tzkvqtcczbwioevojejm.supabase.co",
      publishableKey: "sb_publishable_abc",
    });
    expect(isEnvConfigured("supabasePublic")).toBe(true);
  });

  it("reads the admin, owner, pubsub, anthropic and cron groups", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_xyz");
    vi.stubEnv("ALLOWED_EMAIL", "Owner@Example.com");
    vi.stubEnv("PUBSUB_PUSH_AUDIENCE", "https://segue-five.vercel.app/api/gmail/push");
    vi.stubEnv("PUBSUB_PUSH_SERVICE_ACCOUNT", "Push@project.iam.gserviceaccount.com");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("CRON_SECRET", "0123456789abcdef");

    expect(requireEnv("supabaseAdmin")).toEqual({
      url: "http://localhost:54321",
      secretKey: "sb_secret_xyz",
    });
    expect(requireEnv("owner")).toEqual({ allowedEmail: "owner@example.com" });
    expect(requireEnv("pubsub")).toEqual({
      pushAudience: "https://segue-five.vercel.app/api/gmail/push",
      pushServiceAccount: "push@project.iam.gserviceaccount.com",
    });
    expect(requireEnv("anthropic")).toEqual({ apiKey: "sk-ant-test" });
    expect(requireEnv("cron")).toEqual({ secret: "0123456789abcdef" });
  });

  it("reads the google group", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "GOCSPX-secret");
    vi.stubEnv("GOOGLE_PUBSUB_TOPIC", "projects/segue-123/topics/gmail");
    expect(requireEnv("google")).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
      pubsubTopic: "projects/segue-123/topics/gmail",
    });
  });

  it("uses LLM_MODEL for classify unless LLM_MODEL_CLASSIFY is set", () => {
    vi.stubEnv("LLM_MODEL", "claude-sonnet-5");
    expect(requireEnv("llm")).toEqual({ model: "claude-sonnet-5", classifyModel: "claude-sonnet-5" });
    vi.stubEnv("LLM_MODEL_CLASSIFY", "claude-haiku-4-5");
    expect(requireEnv("llm")).toEqual({ model: "claude-sonnet-5", classifyModel: "claude-haiku-4-5" });
  });

  it("accepts a base64 key of exactly 32 bytes", () => {
    const key = randomBytes(32).toString("base64");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key);
    expect(requireEnv("tokenEncryption")).toEqual({ key });
  });
});

describe("format validation", () => {
  function expectInvalid(group: Parameters<typeof requireEnv>[0], variables: string[], secret: string) {
    const error = catchError(() => requireEnv(group)) as InvalidEnvError;
    expect(error).toBeInstanceOf(InvalidEnvError);
    expect(error).toBeInstanceOf(EnvError);
    expect(error.variables).toEqual(variables);
    expect(error.message).not.toContain(secret);
    expect(readEnv(group)).toBeNull();
  }

  it("rejects a Supabase URL that is not http or https", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "tzkvqtcczbwioevojejm.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    expectInvalid("supabasePublic", ["NEXT_PUBLIC_SUPABASE_URL"], "tzkvqtcczbwioevojejm");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "ftp://example.com");
    expectInvalid("supabasePublic", ["NEXT_PUBLIC_SUPABASE_URL"], "example.com");
  });

  it("rejects an invalid ALLOWED_EMAIL", () => {
    vi.stubEnv("ALLOWED_EMAIL", "not-an-email");
    expectInvalid("owner", ["ALLOWED_EMAIL"], "not-an-email");
  });

  it("rejects an invalid push service account email", () => {
    vi.stubEnv("PUBSUB_PUSH_AUDIENCE", "segue");
    vi.stubEnv("PUBSUB_PUSH_SERVICE_ACCOUNT", "push-account");
    expectInvalid("pubsub", ["PUBSUB_PUSH_SERVICE_ACCOUNT"], "push-account");
  });

  it("rejects a TOKEN_ENCRYPTION_KEY that is not base64 of 32 bytes", () => {
    const short = randomBytes(16).toString("base64");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", short);
    expectInvalid("tokenEncryption", ["TOKEN_ENCRYPTION_KEY"], short);

    const long = randomBytes(33).toString("base64");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", long);
    expectInvalid("tokenEncryption", ["TOKEN_ENCRYPTION_KEY"], long);

    const hex = randomBytes(32).toString("hex");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", hex);
    expectInvalid("tokenEncryption", ["TOKEN_ENCRYPTION_KEY"], hex);

    const unpadded = randomBytes(32).toString("base64").replace(/=+$/, "");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", unpadded);
    expectInvalid("tokenEncryption", ["TOKEN_ENCRYPTION_KEY"], unpadded);
  });

  it("rejects a Google client id or topic in the wrong shape", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "123-abc");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "GOCSPX-secret");
    vi.stubEnv("GOOGLE_PUBSUB_TOPIC", "gmail");
    expectInvalid("google", ["GOOGLE_CLIENT_ID", "GOOGLE_PUBSUB_TOPIC"], "GOCSPX-secret");
  });

  it("rejects a CRON_SECRET shorter than 16 characters", () => {
    vi.stubEnv("CRON_SECRET", "short");
    expectInvalid("cron", ["CRON_SECRET"], "short");
  });

  it("rejects model names with whitespace", () => {
    vi.stubEnv("LLM_MODEL", "claude opus");
    expectInvalid("llm", ["LLM_MODEL"], "claude opus");
  });

  it("reports missing before invalid and lists both in checkEnv", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a url");
    const error = catchError(() => requireEnv("supabaseAdmin")) as MissingEnvError;
    expect(error).toBeInstanceOf(MissingEnvError);
    expect(error.variables).toEqual(["SUPABASE_SECRET_KEY"]);
    expect(error.message).not.toContain("not a url");
    expect(checkEnv("supabaseAdmin")).toEqual({
      ok: false,
      missing: ["SUPABASE_SECRET_KEY"],
      invalid: ["NEXT_PUBLIC_SUPABASE_URL"],
    });
  });
});
