## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran and what they showed. New selectors or platform behavior need a fixture store variant and an integration test. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` (unit, integration and, with Postgres and Redis, e2e)
- [ ] `pnpm build`

## Checklist

- [ ] No test or example reaches a real store; fixtures run on 127.0.0.1
- [ ] Nothing in the journey can submit payment or place an order
- [ ] Result schema changes are additive, or `RESULT_SCHEMA_VERSION` is bumped and CHANGELOG.md says so
- [ ] Docs updated (README, docs/ARCHITECTURE.md, CHANGELOG.md) where behavior changed
