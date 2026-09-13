# Engineering notes

Verified facts and design decisions that the code relies on. Checked against official docs on 2026-09-13. The build plan is `docs/BUILD_PLAN.md`; the product spec is `PLAN.md`.

## Versions in use

Next.js 16.3.5, React 19.2.8, MUI 9.4.0 (`@mui/material-nextjs/v16-appRouter`), `@supabase/supabase-js` 2.116.0, `@supabase/ssr` 0.12.7, `zod` 4.6.4, `@anthropic-ai/sdk` 0.125.0, `@googleapis/gmail` 21.0.0, `google-auth-library` 11.0.2, `diff` 9.0.0 (ships its own types), `vitest` 5.0.0. Deploy target Vercel (Hobby, Fluid compute).

## Next.js 16

- This Next version differs from older training data. Read `node_modules/next/dist/docs/` before using an API.
- Middleware is now **Proxy**: `src/proxy.ts` (same level as `app`), `export async function proxy(request: NextRequest)`, `export const config = { matcher: [...] }` with static strings. Node runtime only.
- `after()` from `next/server` is stable, works in Route Handlers, Server Actions and Server Components, and on Vercel extends the invocation (until `maxDuration`).
- `export const maxDuration = 300` per route, page or layout. Server Actions inherit the page or layout value.
- Server Actions are public POST endpoints. Check auth inside every action. Client calls run one at a time.
- Route Handlers are not cached by default. `params`, `searchParams`, `cookies()`, `headers()` are async.
- Pages that read the database must be dynamic: they call `cookies()` (through the owner check) or `connection()`.
- `LayoutProps<"/route">` and `PageProps<"/route">` global types exist.

## MUI 9

- Deprecated props are removed: `PaperProps`, `InputProps`, `inputProps`, `InputLabelProps`, `components`, `componentsProps`, `TransitionComponent`, system props on `Box`, `Stack`, `Typography` and `Grid`. Use `slotProps` (for TextField: `slotProps.input`, `slotProps.htmlInput`, `slotProps.inputLabel`) and `sx`.
- Import per component path (`@mui/material/Button`). Icons: check the file exists in `node_modules/@mui/icons-material` (for example `MailOutline` does not exist, `EmailOutlined` does).
- Stock components and theme tokens only (`text.secondary`, `divider`, `success.main`, `alpha()` from `@mui/material/styles`). No hardcoded hex or font sizes.

## Supabase

- Project ref `tzkvqtcczbwioevojejm`, Frankfurt. Env names: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`.
- SSR clients follow the current docs: `createBrowserClient(url, publishableKey)`; server `createServerClient` with `cookies: { getAll, setAll(cookiesToSet, headers) }` (ignore the set error inside Server Components); proxy `updateSession` builds the client on the request, calls `supabase.auth.getClaims()` immediately, and returns the same response object, also copying the `headers` passed to `setAll`.
- Protect with `getClaims()`, never `getSession()` on the server.
- Admin client: `createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } })` in a `server-only` module. Secret keys bypass RLS but table GRANTS are still required.
- **New projects do not auto-grant tables to any role, including `service_role`.** Every table needs `grant select, insert, update, delete on table public.x to service_role`, every function `grant execute ... to service_role`. Missing grants return Postgres error `42501`.
- Google sign-in: `signInWithOAuth({ provider: "google", options: { redirectTo, scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send", queryParams: { access_type: "offline", prompt: "consent" } } })`. `provider_token` and `provider_refresh_token` exist only on the session returned by `exchangeCodeForSession` in the callback. Supabase never stores or refreshes them.
- Schema changes: SQL file in `supabase/migrations/`, applied with the Supabase MCP `apply_migration`, then `get_advisors`, then `generate_typescript_types`.

## Postgres functions (because PostgREST updates cannot use expressions)

All `security invoker`, `set search_path = ''`, fully qualified names, `execute` revoked from `public, anon, authenticated` and granted to `service_role` only.

- Claim a unit of work: `attempts = attempts + 1`, `lease_expires_at = now() + lease`, only when `(lease_expires_at is null or lease_expires_at < now()) and attempts < 3` and the status is the expected one. Returns the row or nothing.
- Advance `app_state.history_id` only forward (numeric compare).
- Anything else that needs an atomic read-modify-write.

## Gmail API

- `users.watch` body `{ topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }` returns `{ historyId, expiration }` (epoch ms string). Renew at least every 7 days; the daily cron renews. `users.stop` ends it.
- Push payload: `{ message: { data: base64(JSON {emailAddress, historyId}), messageId, publishTime }, subscription }`. Never use the pushed historyId as `startHistoryId`; use the stored one.
- `users.history.list({ startHistoryId, historyTypes: ["messageAdded"], labelId: "INBOX", pageToken })`, read `history[].messagesAdded[].message.{id, threadId, labelIds}`, save the response `historyId`. HTTP 404 means the start id is too old: fall back.
- `users.messages.get({ format: "full" })`: headers in `payload.headers` (match names case-insensitively), body by walking `payload.parts` recursively, prefer `text/plain`, decode `Buffer.from(data, "base64url")`. Single part bodies are in `payload.body.data`.
- Reply in thread: `users.messages.send({ requestBody: { threadId, raw } })` where raw is base64url RFC 2822 with `To`, `Cc`, `Subject: Re: <original>`, `In-Reply-To: <Message-ID of the replied message>`, `References: <its References> <its Message-ID>`, `Content-Type: text/plain; charset="UTF-8"`. Non-ASCII subject: RFC 2047 encoded word.
- `messageAdded` also fires for his own sent mail. Skip SENT, DRAFT, SPAM labels and his own address.
- Scopes: `gmail.readonly` (restricted) and `gmail.send` (sensitive). Refresh tokens: `new OAuth2Client({ clientId, clientSecret })`, `setCredentials({ refresh_token })`, listen to `tokens` for a rotated refresh token. `invalid_grant` means revoked (password change, user revocation, 6 months unused).

## Pub/Sub push auth

- Request header `Authorization: Bearer <Google-signed OIDC JWT>`. Verify with `new OAuth2Client().verifyIdToken({ idToken, audience })`, then require `payload.email === PUBSUB_PUSH_SERVICE_ACCOUNT` and `payload.email_verified === true`.
- Any 2xx (we use 204) within the ack deadline (default 10 s) acks. Anything else is redelivered with backoff. Deliveries can repeat.

## Vercel

- Hobby cron: at most once a day, fires within the scheduled hour, GET, no retries, can duplicate. `vercel.json` `{ "crons": [{ "path": "/api/cron/daily", "schedule": "0 6 * * *" }] }`. Auth header `Authorization: Bearer ${CRON_SECRET}`.
- Function duration on Hobby: 300 s default and max.

## Claude API

- `new Anthropic()` reads `ANTHROPIC_API_KEY`. Timeout option is in milliseconds. Set `maxRetries: 0`; the pipeline owns retries.
- Model `claude-opus-5`: adaptive thinking is on by default; `temperature`, `top_p`, `top_k`, `budget_tokens` and assistant prefill are rejected. Effort via `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`. `max_tokens` covers thinking plus output, so size it generously.
- Structured output: `output_config: { format: zodOutputFormat(Schema) }` (`import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`), or the raw `{ type: "json_schema", schema }`. Every object is strict. Length and range constraints are not enforced by the API, so validate again with zod in code.
- Always check `stop_reason` before reading output: `"refusal"` (with `stop_details`) and `"max_tokens"` mean the output is unusable.
- Server-side refusal fallback: `client.beta.messages.create({ ..., betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`. The TypeScript types may not include `fallbacks` yet; confirm against `node_modules/@anthropic-ai/sdk` and, if missing, pass it with a narrow, commented type escape.
- Stream long outputs: `client.messages.stream(...)` or `client.beta.messages.stream(...)`, then `await stream.finalMessage()`.
- Error classes: `Anthropic.RateLimitError` (429), `Anthropic.InternalServerError` (5xx incl. 529), `Anthropic.APIConnectionError` and `Anthropic.APIConnectionTimeoutError` (check before `Anthropic.APIError`), `Anthropic.AuthenticationError` (401), `Anthropic.PermissionDeniedError` (403), `Anthropic.BadRequestError` (400, check the message for credit balance problems).
- Prompt caching: `cache_control: { type: "ephemeral" }` on the last system block; minimum 512 tokens on Opus 5; keep the system prompt byte-identical.

## jsdiff

`import { diffWordsWithSpace } from "diff"` returns `{ value, added, removed, count }[]`. Use it for the side-by-side highlight.
