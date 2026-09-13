@AGENTS.md

# Segue

Personal dashboard: watches Gmail for sponsorship offers, writes sponsor-integrated script branches with Claude, owner approves and sends replies.

- Product spec and defaults: `PLAN.md`
- Build plan (phases, data model, agent design): `docs/BUILD_PLAN.md`
- Verified API facts (Next 16, MUI 9, Supabase, Gmail, Pub/Sub, Vercel, Claude): `docs/ENGINEERING.md`. Read the relevant section before touching those APIs.

## Commands

- `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `SEGUE_DEMO=1 pnpm dev` runs the full app on in-memory data, fake Gmail and a scripted AI (development only)

## Rules

- Stock MUI components only, theme tokens, `slotProps` and `sx`. No custom design layer, no hardcoded colors or font sizes.
- UI copy states facts and stops. No emojis. Never use the em dash or en dash characters anywhere (code, comments, copy, docs).
- Every page, Server Action and owner route reads and writes data only through `ownerStore()`. Never import the admin Supabase client from a client component.
- External services go through ports (`Store`, `GmailPort`, `LlmPort`) so the pipeline stays testable offline.
- The app, every route and the build must work with no env vars set: fail closed, never crash.
- Never log or store email content or model output in `error` columns or logs.
- Code style: double quotes, semicolons, 2-space indent, named exports for libraries, default exports for pages and components. Keep comments rare and useful.
- Tests live next to the code as `*.test.ts`. Every change keeps `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green.
- Do not commit. The owner of the session commits.
