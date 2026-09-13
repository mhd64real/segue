# Segue: full build plan

## Context

Mohamed wants a personal tool for his own YouTube channel. Sponsorship offers arrive by Gmail. Segue watches the inbox, spots sponsorship emails, checks each one against the videos he is monitoring, and for the single best fit writes a new version ("branch") of that video's script with the sponsor blended into the story. He reviews branches side by side, approves or rejects, and Segue drafts the acceptance or polite decline, which he edits and sends from the dashboard as a reply in the sponsor's Gmail thread.

Build rule he set: every account and credential step happens at the very END, in one keys session (Phase 10). Phases 1 to 9 are built and verified without keys.

The product spec and accepted defaults live in the repo at `PLAN.md`. This file is the engineering plan. It was reviewed adversarially and the fixes are folded in.

## Where it stands

- Repo `github.com/mhd64real/segue` (public). Local `~/Documents/Projects/new`. Pushes to `main` auto-deploy to Vercel project `segue` (https://segue-five.vercel.app).
- Next.js 16.3.5, React 19.2.8, MUI 9.4.0, pnpm.
- Shell exists: `src/components/DashboardShell.tsx`, `src/components/PageHeader.tsx`, `src/app/(dashboard)/{videos,sponsorships,emails}/page.tsx`, `src/theme.ts`, `src/config.ts`.
- Supabase project `segue` (ref `tzkvqtcczbwioevojejm`, Frankfurt, org mhd64) reachable through the Supabase plugin MCP. URL and publishable key in `.env.local`.

## Changes to PLAN.md (updated in Phase 1)

- **Reply subject is locked** to "Re: original subject". Changing it breaks Gmail threading. To and Cc stay editable.
- **Follow-ups:** a sponsor's reply inside a thread Segue already knows never creates a second sponsorship. The Sponsorships row shows "Sponsor replied".
- **Match again** button on No fit rows, so an old offer can be matched against a video added later.
- **Redraft** button when a branch was edited after its draft was written.
- **Deleting a video** is blocked once a reply for one of its branches has been sent (keeps history).

## Ground rules for every phase

- Stock MUI only, theme tokens, `slotProps` and `sx`. No emojis or dash characters in UI copy. Copy states facts.
- Every phase ends green: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. The build and every route must work with NO env vars (fail closed, no 500s), so Vercel keeps deploying before keys.
- Commits per phase, format `<scope>: <summary>`, author `mhd64.real@gmail.com`, no AI trailer, pushed to `main`. Nothing secret in the public repo.
- Memory file updated at the end of each phase.

## Architecture

```
Gmail inbox --Pub/Sub push (OIDC JWT)--> /api/gmail/push  -> 204 fast
                                              | after()
                                              v
                  syncInbox()    history.list from STORED historyId -> inbox_messages (pending)
                  runPipeline()  classify -> sponsorship -> match -> write branch -> notification
Vercel cron daily -> /api/cron/daily: renew watch, catch-up sync, reclaim expired leases, runPipeline
Check now (topbar) -> same sync + runPipeline
Dashboard: Server Components + Server Actions -> ownerStore() -> Supabase admin client (secret key, server only)
```

- **Auth:** Supabase Auth with Google (PKCE). `src/proxy.ts` refreshes the session with `getClaims()` and redirects pages to `/login`. The real gate is `ownerStore()`: every page, Server Action, and owner route gets data only through it, and it checks claims plus `email === ALLOWED_EMAIL` on every call (layouts do not re-run per action, so a layout check alone is not enough). Missing env means "not signed in", never a crash.
- **Data:** tables in `public`, RLS on, zero grants to `anon` and `authenticated`, explicit grants to `service_role` (new Supabase projects no longer auto-grant, even to `service_role`). The browser never reads the database.
- **Ports:** `GmailPort`, `LlmPort`, `Store`, each with a real and a fake implementation. The pipeline takes `{ store, gmail, llm, clock }` and is fully testable offline.
- **Idempotent writes instead of transactions:** every insert that can be retried uses a unique key with `on conflict do nothing` (sponsorship per message and per thread, branch per sponsorship, notification per branch), and each step checks for its own finished output before calling the model. A crash between writes just finishes on the next claim.
- **Local demo mode:** `SEGUE_DEMO=1 pnpm dev` runs the full app on the in-memory store (kept on `globalThis` so actions, routes and pages share it across hot reloads), fake Gmail and scripted LLM, seeded from the eval fixtures, with a dev-only "Simulate incoming email" control. Active only when `NODE_ENV === "development"`; the server refuses to start if `SEGUE_DEMO` is set in production.

## Data model (migration 1)

| Table | Columns |
|---|---|
| `app_state` (singleton) | `id bool pk default true check (id)`, `google_email`, `refresh_token_enc`, `history_id text`, `watch_expires_at` (null = not watching), `last_checked_at`, `last_error`, `needs_reauth bool`, `llm_paused_reason`, `updated_at` |
| `videos` | `id uuid`, `title`, `script` (check length <= 60000), `monitoring bool`, `created_at`, `updated_at` |
| `inbox_messages` | `gmail_message_id text pk`, `status` (pending, not_sponsorship, followup, sponsorship, skipped, failed), `attempts`, `lease_expires_at`, `error`, `input_tokens`, `output_tokens`, timestamps. No email content. |
| `sponsorships` | `id uuid`, `gmail_message_id unique`, `thread_id unique`, `from_name`, `from_email`, `reply_to`, `cc text[]`, `subject`, `body_text`, `received_at`, `brand`, `product`, `deliverable`, `compensation`, `deadline`, `summary`, `status` (matching, writing, branched, no_fit, failed), `video_id fk on delete set null`, `fit_reason`, `attempts`, `lease_expires_at`, `error`, `input_tokens`, `output_tokens`, `last_reply_at`, timestamps |
| `branches` | `id uuid`, `video_id fk cascade`, `sponsorship_id unique fk cascade`, `base_script`, `script`, `segment_summary`, `status` (pending, approved, rejected), `decided_at`, timestamps |
| `email_drafts` | `id uuid`, `branch_id unique fk cascade`, `kind` (accept, decline), `request_id uuid`, `based_on timestamptz` (branch `updated_at` it was written from), `to_email`, `cc text[]`, `subject`, `body`, `status` (generating, draft, failed, sending, sent), `error`, `sending_started_at`, `gmail_message_id`, `sent_at`, timestamps |
| `notifications` | `id uuid`, `branch_id unique fk cascade`, `read_at`, `created_at` |

- Enums for every status, indexes on status columns and foreign keys, `updated_at` trigger (security invoker).
- `grant select, insert, update, delete ... to service_role` on every table; RLS enabled on all; nothing for `anon` or `authenticated`.
- SQL committed at `supabase/migrations/<timestamp>_initial_schema.sql`, applied with MCP `apply_migration`, then `get_advisors` must be clean, then MCP `generate_typescript_types` into `src/lib/supabase/database.types.ts`.
- `error` columns hold only our own short messages (error class and step). Never model output or zod issue text, which can quote the email.

## Agent design

- **Model:** `LLM_MODEL` default `claude-opus-5`, optional `LLM_MODEL_CLASSIFY` (for example `claude-haiku-4-5`). Adaptive thinking (default) with per-step effort. Server-side refusal fallback on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- **Calls:** structured output via `output_config.format` from a zod schema, parsed again with zod. Check `stop_reason` first (`refusal`, `max_tokens`). SDK `maxRetries: 0` (the pipeline owns retries). Token usage stored per row. Real cost is measured in Phase 10 and an Anthropic workspace spend limit is set there.
- **Untrusted input:** email text goes in delimited data blocks, the system prompt says it is data and never instructions, the model has no tools, output is rendered as plain text, nothing is sent without his click.

| Step | Effort, timeout | Input | Output | Code checks |
|---|---|---|---|---|
| classify | low, 60 s | from, subject, body (capped length) | `is_sponsorship`, `reason`, `offer` {brand, product, deliverable, compensation, deadline, summary} or null | schema |
| match | low, 60 s | offer + each monitored video (id, title, first 8000 chars of script) | `video_id` or null, `reason` | id must be one we sent, else no fit; zero monitored videos means no fit without a call |
| write branch | medium, 200 s, streamed | full original script + offer | `insert_after` (exact quote from the script), `segment` (the sponsor part with transition in and out), `edits` [{find, replace}] (small smoothing changes), `segment_summary` | every quote must match the script exactly once, else the attempt fails; code builds the branch script; prompt requires a clear spoken sponsorship disclosure in the script's own voice |
| draft reply | low, 60 s | offer, segment summary, decision, sponsor name | `body` | subject built in code; prompt asks for short plain emails |

- **Claims and retries:** a claim is one conditional update: `attempts = attempts + 1`, `lease_expires_at = now() + 10 min`, only if no live lease and attempts < 3. A killed function therefore still uses up an attempt, so no endless paid loops. Transient errors (429, 5xx, network, timeout, quote mismatch) release the lease; the third failure sets `failed`. Refusal, `max_tokens`, schema failure set `failed` at once. Cron only reclaims expired leases; it never un-fails a row. The Retry button resets attempts.
- **Account-level errors pause everything instead of failing emails:** Gmail `invalid_grant` sets `needs_reauth` (topbar says Reconnect Google, sign-in again fixes it). Anthropic 401, 403, or out of credit sets `llm_paused_reason` (topbar shows it). The claim's attempt is given back. The next run tries one item and clears the pause on success.
- **Time budget (300 s functions):** `runPipeline` runs items one by one, starts a write-branch step only in the first 60 s of an invocation and short steps only before 230 s. Leftover work is picked up by the next push, Check now, or the daily cron.
- **Flow per item:**
  1. inbox `pending`: fetch message. Labels SENT, DRAFT or SPAM, or from his own address: `skipped`. Thread already has a sponsorship: `followup`, set `last_reply_at`. Otherwise classify: `not_sponsorship`, or insert sponsorship (`matching`) then `sponsorship`.
  2. sponsorship `matching`: match: `no_fit` with reason, or set `video_id` and `writing`.
  3. sponsorship `writing`: branch already exists means `branched`; video gone means `no_fit` "Video deleted"; else write branch, insert branch and notification, `branched`.

## Watch rules

- Watching is on exactly when at least one video has monitoring on.
- Off to on: `watch` (labelIds INBOX, `labelFilterBehavior` INCLUDE), store `history_id` from the response and `last_checked_at = now` (no backlog).
- Renewal (every cron run and on each toggle while on): `watch` again, update `watch_expires_at`, never touch `history_id`.
- On to off (last monitored video switched off or deleted): `stop`, clear `watch_expires_at`.
- `syncInbox` does nothing unless watching. It pages `history.list` from the stored id (historyTypes messageAdded, labelId INBOX), inserts ids, and only ever moves `history_id` forward (compared as BigInt, conditional update, since syncs can overlap). On 404: read the profile historyId first, list inbox messages after `last_checked_at` (capped at 50), then store the profile id and a visible note.

## Phases

Each phase: build, tests, demo-mode screenshots for UI work (1440 and 390 wide), green checks, commit, push, memory update.

### Phase 1: Foundations
- Pinned deps with lockfile: `@supabase/supabase-js`, `@supabase/ssr`, `zod`, `server-only`, `@googleapis/gmail`, `google-auth-library`, `@anthropic-ai/sdk`, `diff`; dev `vitest`.
- `src/lib/env.ts`: lazily read env groups with a clear `MissingEnvError`. `.env.example` lists every variable: Supabase URL, publishable key, secret key, `ALLOWED_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PUBSUB_TOPIC`, `PUBSUB_PUSH_AUDIENCE`, `PUBSUB_PUSH_SERVICE_ACCOUNT`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `LLM_MODEL_CLASSIFY`.
- `src/lib/crypto.ts`: AES-256-GCM, versioned format.
- Supabase clients per current docs: `src/lib/supabase/client.ts`, `server.ts` (`getAll`, `setAll(cookies, headers)`), `proxy.ts` (`updateSession` with `getClaims`), `admin.ts` (secret key, `server-only`, no session persistence).
- Migration 1, advisors, generated types. Grants and RLS proven now with MCP `execute_sql` inside a rolled-back transaction: as `anon` and `authenticated` every table errors, as `service_role` reads and writes work.
- `Store` interface, Supabase implementation, memory implementation, and ONE contract test suite that runs against the memory store now and against Supabase in Phase 10.
- Update `PLAN.md` with the changes listed above.

### Phase 2: Sign in
- `src/proxy.ts` (matcher excludes `_next`, static files, `/api/gmail/push`, `/api/cron`). Without Supabase env it lets requests through; pages then show the sign-in screen with "Setup is not finished".
- `src/lib/owner.ts`: `ownerStore()` (claims + allowlist, or the demo store in demo mode).
- `/login`: "Sign in with Google" calling `signInWithOAuth` with full scope URLs `https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send` and `queryParams { access_type: "offline", prompt: "consent" }`. Messages for not allowed, missing permissions, not configured, failed.
- `/auth/callback`: `exchangeCodeForSession`; wrong email: delete that auth user with the admin API, sign out, redirect with error; check granted scopes via Google tokeninfo on `provider_token` (he can untick send on the consent screen); require `provider_refresh_token`; encrypt and save to `app_state`, clear `needs_reauth`; redirect to `/videos`.
- `/auth/signout`, `AccountMenu` (email, Sign out).
- Demo mode plumbing and guard.
- Tests: allowlist, callback decisions (pure function), demo guard, and a generic test that imports every `actions.ts` export and asserts it rejects with no session and with no env.

### Phase 3: Videos
- `/videos` table (title, monitoring, branches, updated), New video, empty state.
- `/videos/new` title + multiline script (60000 char limit with counter), create, redirect.
- `/videos/[videoId]` edit title and script, Save; Monitoring switch (saves the flag only, watch wiring comes in Phase 5); Delete with confirm, blocked when a reply was sent, otherwise marks its writing or branched sponsorships as `no_fit` "Video deleted" before deleting.
- Tests: validation, delete rules.

### Phase 4: Gmail layer
- `GmailPort`: `watch`, `stop`, `listHistory` (ids + historyId, or `expired`), `listInboxAfter`, `getProfile`, `getMessage`, `getThread`, `sendReply`.
- Google implementation from the decrypted refresh token; persists a rotated refresh token; maps `invalid_grant` to the reauth pause.
- `mime.ts` (case-insensitive headers, recursive parts, text/plain preferred, HTML-to-text fallback, base64url) and `reply.ts` (RFC 2822, `In-Reply-To`, `References`, RFC 2047 subject, base64url).
- Fake implementation for tests and demo.
- Tests with real-shaped fixtures: multipart/alternative, nested mixed, single part, HTML only, odd header casing, reply building.

### Phase 5: Mail watching
- `src/lib/pipeline/watch.ts` (watch rules above) wired into the monitoring switch and video delete.
- `src/lib/pipeline/sync.ts` (sync rules above).
- `/api/gmail/push`: injectable verifier (real one: `verifyIdToken` with `PUBSUB_PUSH_AUDIENCE`, then `email === PUBSUB_PUSH_SERVICE_ACCOUNT` and `email_verified`); ignores other mailboxes; `after(syncInbox then runPipeline)`; 204. Without env: 204, does nothing. `maxDuration = 300`.
- `/api/cron/daily` (Bearer `CRON_SECRET`, constant-time compare; without env returns 200 "not configured"): renew watch, sync, reclaim leases, runPipeline. `vercel.json` cron `0 6 * * *`. Idempotent.
- Topbar: the dashboard layout (server, `maxDuration = 300`) loads status and notifications and passes them to the shell. `TopbarStatus` shows Not connected, Reconnect Google, AI paused, Not watching, Watching (checked N min ago), or Error with tooltip; its menu has Check now (Server Action: sync + `after(runPipeline)`). A small client component calls `router.refresh()` on window focus and every 60 s.
- Tests: sync (normal, duplicates, overlap never moves history back, not watching does nothing, 404 fallback), watch transitions, push route with a locally generated RSA key signing test tokens (bad signature, wrong audience, wrong account, good), cron auth.

### Phase 6: The agent
- `LlmPort`, Anthropic implementation (structured output, stop reasons, fallback beta, streaming for write branch, typed error mapping to transient, final, or account-level), scripted fake.
- Prompts and schemas for the four steps; `applyBranchEdits()` pure function.
- `src/lib/pipeline/process.ts` and `run.ts` (claims, attempts, pauses, time budget, flow above).
- Sponsorships page: table (received, from, brand, subject, status chip with Processing for matching and writing, video link, reason, Sponsor replied), row dialog with extracted fields and email text, Retry on failed, Match again on no fit.
- Tests with the scripted LLM, driven by the eval fixtures: each flow branch above, quote mismatch retries then fails, refusal fails at once, account error pauses without spending attempts, killed run (lease expires) reclaims with attempts counted, duplicate claims do nothing, follow-up in a known thread, `applyBranchEdits` cases.

### Phase 7: Branches
- Video page Branches list (brand, sender, status, created).
- `/videos/[videoId]/branches/[branchId]`: sponsor summary and collapsible original email; "Original changed since this branch" notice; `ScriptDiff` side by side (word diff from `diff`, removed text marked on the left, added on the right, stacked on phones); View and Edit toggle on the branch side with Save; Approve and Reject.
- Approve or Reject: set status, upsert the draft as `generating` with a new `request_id` and `based_on`, `after(draft reply)`; the draft job writes only if `request_id` still matches, so a quick Approve then Reject cannot be overwritten by the older job. A `generating` draft older than 5 minutes shows as failed with Retry. Decision can change until the reply is sent, then the branch locks.
- Branch edited after its draft: notice with Redraft.
- `NotificationsMenu`: unread badge, links to branches, marks read when opened.
- Tests: diff segments, request_id race, lock rules, redraft trigger.

### Phase 8: Emails
- `/emails` tabs Drafts and Sent. Draft card: kind chip (Acceptance, Decline), editable To (prefilled Reply-To or From) and Cc (original Cc minus his address), locked subject, editable body, Save, Send with confirm dialog, generating and failed states.
- Send: claim `draft -> sending` only if the draft kind still matches the branch decision, set `sending_started_at`; fetch the thread, reply to the latest message not from him (`In-Reply-To` and `References` from that message, `threadId`); on success `sent` with Gmail id and time; on a Gmail error back to `draft` with the error.
- A draft stuck in `sending` is never reset automatically. It shows "Check Gmail", which looks in the thread for a message he sent after `sending_started_at`: found means `sent`, not found means back to `draft`.
- Sent tab read-only with a link to the branch.
- Tests with fake Gmail: headers and thread id, double click, kind mismatch, failure path, stuck sending check both ways.

### Phase 9: Hardening
- Eval fixtures (`evals/fixtures`): 3 videos on distinct topics, about 24 emails with expected labels: fitting offers for each video, offers that fit none, brand newsletters, receipts, affiliate spam, unpaid PR pitch, a follow-up in a known thread, a prompt-injection email. Already used by the Phase 6 tests; `pnpm eval` runs them against real Claude in Phase 10.
- `pnpm smoke`: one real call per LLM step plus Gmail `getProfile` and `history.list`, for Phase 10.
- `pnpm test:supabase`: the Store contract suite against the real project (tagged rows, cleaned up), for Phase 10.
- Demo-mode click-through of every flow with screenshots at 1440 and 390; empty, loading and error states reviewed.
- Security pass: every page and action uses `ownerStore()`, push and cron auth, secret key only in `server-only` modules, no HTML rendering of email content, error columns free of email text, advisors clean, `pnpm audit`, repo secret scan.
- `docs/SETUP.md` (runbook below), README, repo `CLAUDE.md` with conventions.

### Phase 10: Keys session (together, at the end)
Runbook in `docs/SETUP.md`, in this order:
1. Supabase secret key into `.env.local`; run `pnpm test:supabase`.
2. Confirm which Google account is the channel inbox; set `ALLOWED_EMAIL`.
3. Google Cloud: create project; enable Gmail API and Pub/Sub API; Auth Platform branding, audience External then Publish app, data access scopes, Web client (origins for Vercel and localhost, redirect URI `https://tzkvqtcczbwioevojejm.supabase.co/auth/v1/callback`). Client id and secret into `.env.local`.
4. Supabase: Google provider on with the same client id and secret; URL configuration (Site URL and redirect URLs for Vercel and localhost).
5. Pub/Sub: topic; Publisher role for `gmail-api-push@system.gserviceaccount.com`; push service account; Token Creator for the Pub/Sub service agent; push subscription to `https://segue-five.vercel.app/api/gmail/push` with that account and audience. Values into `.env.local`.
6. Generate `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET` locally; Anthropic API key; set a monthly spend limit on the Anthropic workspace.
7. Push env vars to Vercel production from `.env.local` without printing values; redeploy.
8. `pnpm smoke`.
9. Live checks: sign in on the live URL and another Google account is refused; create a video, monitoring on, topbar shows Watching; a test sponsorship from another account becomes a branch; a normal email leaves only an id; approve, edit, send, and the reply appears in the sponsor's thread; reject another and send the decline; call the cron route with the secret and see Checked update.
10. `pnpm eval` against real Claude; adjust prompts or effort until every fixture lands right; review stored token usage for real cost; commit.

## Verification summary

- Per phase: typecheck, lint, vitest, env-less build, demo-mode screenshots for UI phases, advisors after schema changes.
- Before keys: grants and RLS proven through MCP; demo mode runs simulate email, branch, approve, draft, send (fake) with every state visible.
- With keys: `pnpm test:supabase`, `pnpm smoke`, the live checks (the original "done when" list from `PLAN.md`), `pnpm eval`.
