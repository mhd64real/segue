import { z } from "zod";

// Every value is read from process.env at call time, never at import time, so modules
// that import this file load fine with no env vars set. NEXT_PUBLIC_ variables are
// referenced literally because Next.js only inlines literal references.

export const DEFAULT_LLM_MODEL = "claude-opus-5";

type RawEnv = Record<string, string | undefined>;

const noWhitespace = z.string().regex(/^\S+$/);
const httpUrl = z.url({ protocol: /^https?$/ });

// Base64 (standard alphabet, padded) that decodes to exactly 32 bytes.
const base64Key32 = z
  .base64()
  .refine((value) => {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - padding === 32;
  });

interface GroupSpec<T> {
  read: () => RawEnv;
  optional?: readonly string[];
  schema: z.ZodType<T>;
}

function defineGroup<T>(spec: GroupSpec<T>): GroupSpec<T> {
  return spec;
}

const groups = {
  supabasePublic: defineGroup({
    read: () => ({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
    schema: z
      .object({
        NEXT_PUBLIC_SUPABASE_URL: httpUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: noWhitespace,
      })
      .transform((v) => ({
        url: v.NEXT_PUBLIC_SUPABASE_URL,
        publishableKey: v.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      })),
  }),
  supabaseAdmin: defineGroup({
    read: () => ({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    }),
    schema: z
      .object({
        NEXT_PUBLIC_SUPABASE_URL: httpUrl,
        SUPABASE_SECRET_KEY: noWhitespace,
      })
      .transform((v) => ({ url: v.NEXT_PUBLIC_SUPABASE_URL, secretKey: v.SUPABASE_SECRET_KEY })),
  }),
  owner: defineGroup({
    read: () => ({ ALLOWED_EMAIL: process.env.ALLOWED_EMAIL }),
    schema: z
      .object({ ALLOWED_EMAIL: z.email() })
      .transform((v) => ({ allowedEmail: v.ALLOWED_EMAIL.toLowerCase() })),
  }),
  google: defineGroup({
    read: () => ({
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_PUBSUB_TOPIC: process.env.GOOGLE_PUBSUB_TOPIC,
    }),
    schema: z
      .object({
        GOOGLE_CLIENT_ID: z.string().regex(/^\S+\.apps\.googleusercontent\.com$/),
        GOOGLE_CLIENT_SECRET: noWhitespace,
        GOOGLE_PUBSUB_TOPIC: z.string().regex(/^projects\/[^/\s]+\/topics\/[^/\s]+$/),
      })
      .transform((v) => ({
        clientId: v.GOOGLE_CLIENT_ID,
        clientSecret: v.GOOGLE_CLIENT_SECRET,
        pubsubTopic: v.GOOGLE_PUBSUB_TOPIC,
      })),
  }),
  pubsub: defineGroup({
    read: () => ({
      PUBSUB_PUSH_AUDIENCE: process.env.PUBSUB_PUSH_AUDIENCE,
      PUBSUB_PUSH_SERVICE_ACCOUNT: process.env.PUBSUB_PUSH_SERVICE_ACCOUNT,
    }),
    schema: z
      .object({
        PUBSUB_PUSH_AUDIENCE: noWhitespace,
        PUBSUB_PUSH_SERVICE_ACCOUNT: z.email(),
      })
      .transform((v) => ({
        pushAudience: v.PUBSUB_PUSH_AUDIENCE,
        pushServiceAccount: v.PUBSUB_PUSH_SERVICE_ACCOUNT.toLowerCase(),
      })),
  }),
  tokenEncryption: defineGroup({
    read: () => ({ TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY }),
    schema: z
      .object({ TOKEN_ENCRYPTION_KEY: base64Key32 })
      .transform((v) => ({ key: v.TOKEN_ENCRYPTION_KEY })),
  }),
  anthropic: defineGroup({
    read: () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
    schema: z
      .object({ ANTHROPIC_API_KEY: noWhitespace })
      .transform((v) => ({ apiKey: v.ANTHROPIC_API_KEY })),
  }),
  cron: defineGroup({
    read: () => ({ CRON_SECRET: process.env.CRON_SECRET }),
    schema: z
      .object({ CRON_SECRET: z.string().regex(/^\S{16,}$/) })
      .transform((v) => ({ secret: v.CRON_SECRET })),
  }),
  llm: defineGroup({
    read: () => ({
      LLM_MODEL: process.env.LLM_MODEL,
      LLM_MODEL_CLASSIFY: process.env.LLM_MODEL_CLASSIFY,
    }),
    optional: ["LLM_MODEL", "LLM_MODEL_CLASSIFY"],
    schema: z
      .object({
        LLM_MODEL: noWhitespace.optional(),
        LLM_MODEL_CLASSIFY: noWhitespace.optional(),
      })
      .transform((v) => {
        const model = v.LLM_MODEL ?? DEFAULT_LLM_MODEL;
        return { model, classifyModel: v.LLM_MODEL_CLASSIFY ?? model };
      }),
  }),
};

type Groups = typeof groups;

export type EnvGroupName = keyof Groups;

export type EnvGroups = {
  [G in EnvGroupName]: Groups[G] extends GroupSpec<infer T> ? T : never;
};

export const ENV_GROUP_NAMES = Object.keys(groups) as EnvGroupName[];

export class EnvError extends Error {
  readonly group: EnvGroupName;
  readonly variables: readonly string[];

  constructor(message: string, group: EnvGroupName, variables: readonly string[]) {
    super(message);
    this.name = "EnvError";
    this.group = group;
    this.variables = variables;
  }
}

export class MissingEnvError extends EnvError {
  constructor(group: EnvGroupName, variables: readonly string[]) {
    super(`Missing environment variables for ${group}: ${variables.join(", ")}`, group, variables);
    this.name = "MissingEnvError";
  }
}

export class InvalidEnvError extends EnvError {
  constructor(group: EnvGroupName, variables: readonly string[]) {
    super(`Invalid environment variables for ${group}: ${variables.join(", ")}`, group, variables);
    this.name = "InvalidEnvError";
  }
}

export type EnvCheck<G extends EnvGroupName> =
  | { ok: true; value: EnvGroups[G] }
  | { ok: false; missing: string[]; invalid: string[] };

function normalize(raw: RawEnv): RawEnv {
  const out: RawEnv = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmed = value?.trim();
    out[name] = trimmed ? trimmed : undefined;
  }
  return out;
}

// Reports missing and invalid variable names. Values never appear in the result.
export function checkEnv<G extends EnvGroupName>(group: G): EnvCheck<G> {
  const spec = groups[group] as GroupSpec<EnvGroups[G]>;
  const values = normalize(spec.read());
  const optional = new Set(spec.optional ?? []);
  const missing = Object.keys(values).filter((name) => values[name] === undefined && !optional.has(name));
  const parsed = spec.schema.safeParse(values);
  if (missing.length === 0 && parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const invalid = parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues
            .map((issue) => String(issue.path[0] ?? ""))
            .filter((name) => name && !missing.includes(name)),
        ),
      ];
  return { ok: false, missing, invalid };
}

// Returns the group or throws MissingEnvError (or InvalidEnvError when everything is
// present but a value has the wrong format).
export function requireEnv<G extends EnvGroupName>(group: G): EnvGroups[G] {
  const result = checkEnv(group);
  if (result.ok) {
    return result.value;
  }
  if (result.missing.length > 0) {
    throw new MissingEnvError(group, result.missing);
  }
  throw new InvalidEnvError(group, result.invalid);
}

// Returns the group, or null when any variable is missing or invalid.
export function readEnv<G extends EnvGroupName>(group: G): EnvGroups[G] | null {
  const result = checkEnv(group);
  return result.ok ? result.value : null;
}

export function isEnvConfigured(group: EnvGroupName): boolean {
  return checkEnv(group).ok;
}
