# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The run result JSON has its own version
(`schemaVersion`), listed with each release.

## [Unreleased]

Result schema version: 1 (unchanged).

### Added

- SSRF guard for every URL fetched on a user's behalf (monitor product URLs, webhook and Slack
  URLs). Refuses non-http(s) schemes, credentials in URLs, ports other than 80 and 443, and
  hosts that are or resolve to loopback, private, CGNAT, link-local (including
  `169.254.169.254`), unique-local, IPv4-mapped, multicast, unspecified or reserved addresses.
  Slack channel URLs must start with `https://hooks.slack.com/`.
- The API checks monitor and alert URLs on create and update (400 with field-level issues).
- The worker checks again at use time: before each run (refused runs are stored as `error`,
  with no alert), on every connection of the journey's browser through a per-run egress proxy
  (redirect hops included), and on every alert delivery. Connections go to the address that
  was checked, which closes DNS rebinding.
- `ALLOW_PRIVATE_TARGETS` (default `false`), `ALLOWED_TARGET_HOSTS` and `ALLOWED_TARGET_PORTS`
  settings for the API and worker.
- CLI flag `--block-private-targets` for `run` and `check`. It applies the worker's rules,
  ports included, and reads `ALLOWED_TARGET_HOSTS` and `ALLOWED_TARGET_PORTS`. Without it the
  CLI still reaches private addresses, as before.
- Refusal reasons for names never include the address the name resolved to; the API and
  worker log it at debug level.
- Step details list requests the guard refused (`blockedRequests`). A refused navigation or
  redirect hop fails the step and is named in its message; a refused subresource does not.
- Fixture variant `redirect-to-loopback`.
- Stale-run sweep in the worker. Runs still `running` `RUN_STALE_AFTER_MS` after they started
  (default 15 minutes, raised when the timeouts allow longer runs) are marked `error` with
  `Worker lost: ...`. Health, failure counts and alerts are not affected. It runs when a worker
  starts and every `HOUSEKEEPING_INTERVAL_MS` (default 5 minutes; `0` turns it off on that
  worker), under a Redis lock so one pass runs at a time.
- Retention in the same pass. Runs older than `RUN_RETENTION_DAYS` (default 30; `0` keeps
  everything) are deleted in batches with their alert deliveries and artifact directories. Each
  monitor keeps its latest run, the run its status points at and the run behind its latest alert
  of each kind. Artifact directories of deleted monitors are removed too.
- Worker metrics `checkout_sentinel_runs_swept_total`, `checkout_sentinel_discarded_results_total`,
  `checkout_sentinel_runs_deleted_total`, `checkout_sentinel_artifact_dirs_deleted_total` and
  `checkout_sentinel_housekeeping_failures_total{task}`.
- Migration `0001_run_housekeeping_indexes` adds indexes on `runs (started_at)` and on
  `runs (started_at)` for running rows. It does not build them `CONCURRENTLY`, so writes to `runs`
  wait while it runs.

### Changed

- Alert deliveries no longer use `fetch`. A redirect answer is now a final failed delivery
  (`HTTP 302 (redirects are not followed)`) instead of a retried network error.
- Local development and tests against fixture stores on 127.0.0.1 need
  `ALLOW_PRIVATE_TARGETS=true` on the API and worker.
- A run's final status is written once. A result that arrives after its run was marked lost (or
  deleted) is discarded: no state change, no alert, and the job completes with outcome
  `discarded`. A worker exception no longer overwrites a run that already has a final status.

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
