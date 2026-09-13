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
- `LayoutProps<"/route">` and `PageProps<"/route">` global types exist. They are generated into `.next/types`; run `pnpm exec next typegen` (or a build) before `pnpm typecheck` after adding a route.
- `src/instrumentation.ts` `register()` runs once per server instance, never during `next build`. A throw there makes the server fail every request ("Failed to prepare server").
- Only one `next dev` may run per project directory (Next holds a lockfile and a second one exits); stop one before starting another on a different port.
- Proxy matcher tests: `unstable_doesMiddlewareMatch({ config, url })` from `next/experimental/testing/server` (the docs call it `unstable_doesProxyMatch`, which 16.3.5 does not export).
- `connection()` from `next/server` throws outside a request scope, so tests that reach it mock it.
- Server Action cache updates: `revalidatePath(path)`, `updateTag(tag)` and `refresh()` from `next/cache`. Called in an action, `revalidatePath` re-renders the current route in the same response, so fresh props arrive with the action result. Dashboard pages are dynamic, so it only needs the literal paths whose data changed (for example `/videos` and `/videos/<id>`).
- A Server Action that calls `redirect()` rejects the client side promise with the redirect error after starting the navigation. Client wrappers around an action must let that error through.
- React 19 calls `form.reset()` after a `<form action={fn}>` submission finishes, even when the action returned field errors. Forms keep `action` for submits before hydration and also dispatch from `onSubmit` (`preventDefault`, then the action inside `startTransition`), which skips the reset (see `src/lib/form-submit.ts`).
- `notFound()` from a page renders the stock 404 inside the parent layouts, and its inline CSS sets the body background (black under a dark OS color scheme). A `not-found.tsx` in the page's own segment wraps that page and replaces the stock UI (`videos/[videoId]/not-found.tsx`, checked in demo mode). Under a `loading.tsx` the response has already started streaming, so the status is 200 with a `noindex` meta tag.
- `error.tsx` is a client component that gets `ErrorInfo` from `next/error` (`{ error, reset, retry }`); `retry()` refreshes the route and re-renders the segment. It wraps the pages below it but not the `layout.tsx` next to it, so `(dashboard)/error.tsx` keeps the shell. `notFound()` and `redirect()` pass through it, and it clears on navigation.
- A `loading.tsx` shows its fallback only when a child segment of its own folder changes (checked in demo mode): `(dashboard)/loading.tsx` covers the sidebar, `(dashboard)/videos/loading.tsx` covers moving between the list, New video and a video page. Server Action re-renders keep the page on screen. A layout that reads cookies (the dashboard layout) still blocks a first navigation into it.
- Unsaved changes: `<Link onNavigate={(event) => event.preventDefault()}>` cancels a client side navigation. The handler is synchronous and runs only for same-origin, unmodified clicks; `router.push`, a Server Action `redirect()` and browser back or forward never call it. Editors call `useUnsavedChanges(dirty)` (`src/components/NavigationGuardProvider.tsx`): links rendered through `GuardedLink` (the sidebar and `LinkButton`) then open "Discard unsaved changes?" and navigate with `router.push` on confirm, and a `beforeunload` listener covers reload and tab close.
- Clearing a cookie on a Route Handler response: use `response.cookies.delete({ name, path })`. When the same request also wrote cookies through `cookies()`, Next re-parses the response `Set-Cookie` header and drops `Max-Age=0`, while an epoch `Expires` survives.

## MUI 9

- Deprecated props are removed: `PaperProps`, `InputProps`, `inputProps`, `InputLabelProps`, `components`, `componentsProps`, `TransitionComponent`, system props on `Box`, `Stack`, `Typography` and `Grid`. Use `slotProps` (for TextField: `slotProps.input`, `slotProps.htmlInput`, `slotProps.inputLabel`) and `sx`.
- Import per component path (`@mui/material/Button`). Icons: check the file exists in `node_modules/@mui/icons-material` (for example `MailOutline` does not exist, `EmailOutlined` does).
- Stock components and theme tokens only (`text.secondary`, `divider`, `success.main`, `alpha()` from `@mui/material/styles`). No hardcoded hex or font sizes.
- Theme color paths go in `sx`: `<Typography sx={{ color: "text.secondary" }}>`. Typography's `color` prop only matches palette keys (`primary`, `error`) and `textPrimary`, `textSecondary`, `textDisabled`; a dotted value such as `color="text.secondary"` is not passed to `sx` and renders no color at all (checked with an SSR render on 9.4.0). The type accepts any string, so `tsc` does not catch it; an ESLint `no-restricted-syntax` rule in `eslint.config.mjs` does.

## Supabase

- Project ref `tzkvqtcczbwioevojejm`, Frankfurt. Env names: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`.
- SSR clients follow the current docs: `createBrowserClient(url, publishableKey)`; server `createServerClient` with `cookies: { getAll, setAll(cookiesToSet, headers) }` (ignore the set error inside Server Components); proxy `updateSession` builds the client on the request, calls `supabase.auth.getClaims()` immediately, and returns the same response object, also copying the `headers` passed to `setAll`.
- Protect with `getClaims()`, never `getSession()` on the server.
- Admin client: `createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } })` in a `server-only` module. Secret keys bypass RLS but table GRANTS are still required.
- **Never rely on default grants.** Every table needs `grant select, insert, update, delete on table public.x to service_role`, every function `grant execute ... to service_role`. Missing grants return Postgres error `42501`. In this project `pg_default_acl` still gives new `public` tables and functions to `anon`, `authenticated` and `service_role` (checked 2026-09-13), and Postgres gives `execute` to `public`, so every migration also runs `revoke all ... from public, anon, authenticated, service_role` before its grants.
- supabase-js 2.116 retries idempotent reads (GET, HEAD) after network errors and HTTP 503 or 520, with backoff, up to 3 times. RPC calls and writes are never retried.
- Google sign-in: `signInWithOAuth({ provider: "google", options: { redirectTo, scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send", queryParams: { access_type: "offline", prompt: "consent" } } })`. `provider_token` and `provider_refresh_token` exist only on the session returned by `exchangeCodeForSession` in the callback. Supabase Auth never stores or refreshes them.
- `@supabase/ssr` 0.12.7 saves that whole session, Google tokens included, into the `sb-<ref>-auth-token` cookie (defaults `httpOnly: false`, 400 day `maxAge`), and nothing removes them until the next token refresh. The callback therefore calls `setSession({ access_token, refresh_token })` right after the exchange: it rewrites the cookie without them and clears leftover chunks. It makes a `/user` request, so its error counts as a failed sign in. In a Route Handler `cookies().getAll()` already includes cookies set earlier in the same request, which is what lets the rewrite see and clear the old chunks.
- Sign-in method: the access token `amr` claim lists methods as strings or `{ method, timestamp }` entries. `oauth` is a social sign-in; `password`, `otp`, `magiclink`, `email/signup`, `recovery`, `sso/saml`, `anonymous` and `oauth_provider/authorization_code` are other ways in. The owner gate requires `oauth` (Google is the only OAuth provider), because the Email provider is on until Phase 10 and a confirmed password account for `ALLOWED_EMAIL` would otherwise pass. `app_metadata.provider` describes the account, not the session, so it is not used.
- Schema changes: SQL file in `supabase/migrations/`, applied with the Supabase MCP `apply_migration`, then `get_advisors`, then `generate_typescript_types`.
- Redirect URL allow list entries are globs matched against the whole URL, and Supabase recommends exact entries in production. `redirectTo` is therefore exactly `<origin>/auth/callback`; the page to return to travels in the short-lived `segue_next` cookie (path `/auth/callback`), never in the query.
- `GET <url>/auth/v1/settings` with the `apikey` header returns the public Auth settings, including `external.google` (checked 2026-09-13: google is off, the email provider is on with confirmation required). `/login` uses it for the "Setup is not finished" state.
- The callback verifies identity with `getClaims(session.access_token)` right after `exchangeCodeForSession`, instead of reading the cookies it just wrote. Deleting a user does not expire its access tokens, so a refused account is signed out with scope `global` before `auth.admin.deleteUser`. A failed `exchangeCodeForSession` writes no cookie (auth-js saves the session only on success, and a missing PKCE verifier fails before any request), so that failure does not sign out: `/auth` is public and the cookies are `SameSite=lax`, so a cross-site link to `/auth/callback?code=x` would otherwise end the owner's session. Failures after the exchange sign out with scope `local`, which removes the cookie even when the `/logout` request fails.
- Google tokeninfo: `POST https://oauth2.googleapis.com/tokeninfo` with `Authorization: Bearer <access token>` (as `google-auth-library` `getTokenInfo` does) returns `scope` as a space separated list.

## Postgres functions (because PostgREST updates cannot use expressions)

All `security invoker`, `set search_path = ''`, fully qualified names, `execute` revoked from `public, anon, authenticated` and granted to `service_role` only.

- Claim a unit of work: `attempts = attempts + 1`, `lease_expires_at = now() + lease`, only when `(lease_expires_at is null or lease_expires_at < now()) and attempts < 3` and the status is the expected one. Returns the row or nothing.
- Advance `app_state.history_id` only forward (numeric compare).
- Anything else that needs an atomic read-modify-write.
- Migration 1 defines: `claim_inbox_message`, `release_inbox_message`, `settle_inbox_message`, `claim_sponsorship`, `release_sponsorship`, `settle_sponsorship`, `retry_sponsorship`, `record_sponsor_reply`, `reclaim_expired_leases`, `advance_history_id`, `delete_video`, `update_branch_script`, `decide_branch`, `claim_draft_send`. Row locks are always taken in the order video, branch, draft. The `Store` in `src/lib/store` is the only caller.

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
