# cf-chat

AI support widget, help centre and shared inbox on Cloudflare Workers and Neon.
Working name. See `docs/plan.md` for scope and build order, `docs/architecture.md`
for how the pieces fit, `docs/decisions/` for why.

## Layout

| Path | What |
|---|---|
| `apps/app` | TanStack Start dashboard + Hono API. The main Worker. |
| `apps/widget` | Embed Worker. Placeholder until build step 5. |
| `packages/shared` | Branded ids, zod boundary schemas, `AppError`, `Result`, session and password primitives. |
| `packages/db` | Drizzle schema, migrations, Hyperdrive client, tenant-scoped repositories. |
| `packages/retrieval` | `Retriever` interface and `FixtureRetriever`. |
| `packages/reply-loop` | `Generator` interface and `FixtureGenerator`. |

## Commands

```sh
pnpm install
pnpm dev          # vite dev on :3000, widget runs as an auxiliary Worker
pnpm typecheck    # tsc across the workspace
pnpm lint         # biome check
pnpm format       # biome check --write
pnpm test         # vitest: node projects for packages, Workers pool for apps
```

Per package: `pnpm --filter @cf-chat/db generate` (new migration from schema
changes), `pnpm --filter @cf-chat/db migrate` (apply to Neon),
`pnpm --filter @cf-chat/app deploy`.

## First-time setup

1. **Create the account resources.** The Hyperdrive one needs your Neon
   credentials, so it is not something to paste into a shared shell.

   ```sh
   pnpm exec wrangler kv namespace create KV
   pnpm exec wrangler hyperdrive create cf-chat-neon --connection-string="postgres://app_user:...@...neon.tech/..."
   ```

   Put the returned ids into `apps/app/wrangler.jsonc`, replacing
   `REPLACE_WITH_KV_NAMESPACE_ID` and `REPLACE_WITH_HYPERDRIVE_ID`.

2. **Environment.** In `.env` at the repo root:

   ```
   DATABASE_URL=postgres://<owner>@<host>/<db>          # direct Neon, drizzle-kit only
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://app_user@<host>/<db>
   ```

   `DATABASE_URL` uses the owner role because migrations create objects.
   Everything else connects as `app_user`, which is what makes row level
   security meaningful later (ADR-009).

   In `apps/app/.dev.vars` (see `.dev.vars.example`): `SESSION_SECRET`.
   In production: `pnpm exec wrangler secret put SESSION_SECRET`.

3. **Migrate, then set the app role's password.** The password is deliberately
   not in the migration:

   ```sh
   pnpm --filter @cf-chat/db migrate
   psql "$DATABASE_URL" -c "ALTER ROLE app_user WITH LOGIN PASSWORD '<secret>';"
   ```

## CI

Workers Builds is configured in the Cloudflare dashboard against a GitHub
repository, so there is no CI file in the repo. Once a remote exists, connect
each Worker with:

| | `cf-chat-app` | `cf-chat-widget` |
|---|---|---|
| Root directory | `apps/app` | `apps/widget` |
| Build command | `pnpm install && pnpm build` | `pnpm install` |
| Deploy command | `pnpm exec wrangler deploy` | `pnpm exec wrangler deploy` |

## Notes

- `main` in `apps/app/wrangler.jsonc` points at `./src/server.ts`, deliberately,
  not at `@tanstack/react-start/server-entry` as the Cloudflare framework guide
  shows. That package export is a self-contained default entry that never imports
  our server file, so pointing `main` at it silently drops the Hono API and every
  named export while the build still succeeds. See ADR-010.
- `compatibility_date` is pinned to `2026-08-22` across dev, test and deploy.
  That is the newest date the test pool's bundled runtime accepts; letting the
  three drift is not worth the twelve days.
- Tests never touch live bindings. AI Search and Workers AI have no local
  emulation, and hitting them would burn allowance and make results
  nondeterministic, so `FixtureRetriever` and `FixtureGenerator` exist.
- Tests that need Postgres are guarded on `TEST_DATABASE_URL` and skip without
  it. Hyperdrive has no local emulation either.
