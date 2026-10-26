# Contributing

Thanks for helping. This project checks real stores, so correctness and politeness come before
features.

## Setup

```bash
nvm use            # Node 22
npm i -g pnpm@11   # pnpm 11
pnpm install
pnpm --filter @checkout-sentinel/core exec playwright install chromium
pnpm build
```

For the e2e tests, run Postgres and Redis locally (or `docker compose up -d postgres redis`) and
create a test database:

```bash
createdb checkout_sentinel_test
export TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/checkout_sentinel_test
export TEST_REDIS_URL=redis://127.0.0.1:6379/15
```

The e2e tests truncate tables and clear the queue in that database and Redis DB, so never point
them at real data.

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit + integration + e2e (e2e skips without Postgres and Redis)
pnpm build
```

## Rules

- **No real stores in tests or examples.** Add a fixture variant in `test/fixtures` that
  reproduces the markup or behavior, then an integration test in `packages/core/test/integration`
  asserting the step that passes or fails.
- **Never submit payment or place an order.** Do not add code that fills or clicks anything on a
  checkout page. If a platform has a new order endpoint, add it to `packages/core/src/safety.ts`
  with a unit test.
- **Outbound requests.** Anything that fetches a URL a user supplied goes through `TargetGuard`
  (`packages/core/src/ssrf.ts`): check the URL, then connect with `guard.lookup` so the socket
  uses the address that was checked. Never follow redirects without checking each hop. Tests
  that run the API or worker against fixture stores on 127.0.0.1 set
  `ALLOW_PRIVATE_TARGETS=true` or allow the fixture's host and port explicitly.
- **Result schema.** Additive, optional fields are fine. Renaming or removing a field, or
  changing its meaning, bumps `RESULT_SCHEMA_VERSION` and goes in CHANGELOG.md.
- **Database.** Change `packages/db/src/schema.ts`, then run `pnpm --filter @checkout-sentinel/db
db:generate --name <change>` and commit the generated SQL. Never edit an applied migration.
- **TypeScript** is strict; avoid `any` and non-null assertions in source code.
- **Comments** explain constraints and reasons, not what the next line does.
- **Dashboard.** `apps/web` is Vue 3 with the Composition API and hand-written CSS on the
  tokens in `src/styles/tokens.css`. Keep controls native (`<button>`, `<a>`, labelled inputs),
  keep text at WCAG AA contrast in both modes, and render store content as text, never with
  `v-html`. Validate forms with the schemas from `@checkout-sentinel/core/schemas` rather than
  repeating rules. Component tests go in `apps/web/test/unit` (Vitest with jsdom); run the app
  with `pnpm --filter @checkout-sentinel/web dev` against an API on port 3000. After a visible
  change, retake the README screenshots with `pnpm --filter @checkout-sentinel/web screenshots`.
- **Docs.** README and docs/ARCHITECTURE.md use plain, concrete English. No made-up numbers.

## Commits

Conventional commits, for example `feat(core): detect BigCommerce`, `fix(worker): release lock
on timeout`, `docs: explain slow alerts`. Keep each commit to one logical change.
