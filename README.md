# Segue

Watches Gmail for sponsorship offers and writes sponsor-integrated branches of video scripts for review. See [PLAN.md](PLAN.md).

## Development

```sh
pnpm install
pnpm dev
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Database schema lives in `supabase/migrations`. `pnpm test:supabase` runs the Store contract suite against the Supabase project named by `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` (environment or `.env.local`); it fails when either variable is missing or invalid, and refuses to run against a database that holds real data.
