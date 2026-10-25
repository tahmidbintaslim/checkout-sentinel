# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The run result JSON has its own version
(`schemaVersion`), listed with each release.

## [0.1.0] - 2026-10-25

First release. Result schema version: 1.

### Added

- Core journey engine on Playwright: open product, find add to cart, add to cart, verify cart,
  go to checkout, checkout renders. Desktop and mobile profiles, one fresh context per journey.
- Platform detection for Shopify and WooCommerce from weighted page and header signals, with a
  generic accessible-name fallback for other stores.
- Per-step status, duration, console errors, page exceptions and failed requests; screenshot and
  Playwright trace on failure.
- Versioned run result schema (zod, exportable as JSON Schema) and CLI exit codes.
- Order guard that aborts order placement and payment requests during a journey.
- CLI: `run`, `check` and `init` with a YAML monitors config.
- NestJS API: monitors CRUD, latest status, run history, run now, alert log, OpenAPI at `/docs`,
  bearer token auth, health and Prometheus metrics.
- BullMQ worker: cron schedules per monitor, per-store concurrency lock, shared browser, alert
  state machine (failure, recovery, slow) with idempotent delivery to webhooks and Slack, metrics.
- Postgres schema and migrations with Drizzle.
- Dockerfile with api and worker targets, docker compose stack, CI workflow.
- Local fixture stores with broken variants, and unit, integration and e2e tests.
