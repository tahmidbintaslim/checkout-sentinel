# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The run result JSON has its own version
(`schemaVersion`), listed with each release.

## [Unreleased]

### Added

- Read-only dashboard demo (`vite build --mode demo`, `pnpm --filter @checkout-sentinel/web demo`):
  the dashboard reads sample data from static JSON and answers every write with 403. The data
  comes from `demo:data`, which runs real journeys against the fixture stores (one store fails on
  mobile for three runs, then recovers) and derives status and alerts with the worker's state
  machine. A GitHub Pages workflow (`demo-pages.yml`) and `apps/web/vercel.json` publish it.

### Changed

- The dashboard's router and the demo data follow the Vite base path (`--base`). The API client
  still calls `/api` on the same origin.

## [0.2.0] - 2026-10-26

Result schema version: 1 (unchanged; new step details are additive).

### Added

- Dashboard (`apps/web`, Vue 3 and Vite), served by the API at `/`: monitors with their
  status, last run, failed runs in a row and slow steps; a monitor's latest result per device,
  paginated run history, Run now, edit and delete; a run's step timeline per device with
  durations, the failure message, console and page errors, failed requests, step details, the
  failure screenshot and a trace download; create and edit forms validated with the API's own
  schemas; and the alert log. Asks for `API_TOKEN` on the first 401 and keeps it in the tab's
  `sessionStorage`. Light and dark mode follow the system setting.
- Every API route also answers under `/api` (`/api/monitors` is `/monitors`). The OpenAPI
  document lists `/api` as its server; paths and metric route labels are unchanged.
- `GET /alerts`: alert deliveries of every monitor with the monitor's name, newest first,
  `?monitorId=&limit=&before=` (the cursor is the last delivery's id).
- `GET /runs/:id/artifacts/:name` serves a screenshot or trace that the run's result names, from
  the API's `ARTIFACTS_DIR`. `GET /runs/:id` lists them in a new `artifacts` field.
- A `PATCH` of `alerts` can keep a saved channel with `{ "type": "stored", "index": n }`, since
  Slack URLs and webhook secrets are never returned. An index past the end of the saved list is
  a 400 at `alerts.<position>.index`.
- `PATCH /monitors/:id` takes `expectedUpdatedAt`, the monitor's `updatedAt` as the client read
  it, and answers 409 without writing anything when the monitor changed since. It is required
  with stored channel references, so an index from an older read never keeps the wrong channel.
  Every update moves `updatedAt` forward by at least one millisecond, on the database's clock.
- `@checkout-sentinel/core/schemas`: the monitor and result schemas without Playwright or Node
  modules, for browser code.
- API settings `DASHBOARD_ENABLED` (default `true`), `DASHBOARD_DIR` (default the
  `apps/web/dist` build) and `ARTIFACTS_DIR` (default `./artifacts`, as on the worker).
- The api Docker image contains the built dashboard (`DASHBOARD_DIR=/app/web`,
  `ARTIFACTS_DIR=/data/artifacts`). docker compose mounts the artifacts volume read-only on the
  API.
- `pnpm --filter @checkout-sentinel/web screenshots` takes the README screenshots from real
  runs against the fixture stores.
- Variant selection in `find_add_to_cart`. Before looking for the add-to-cart control, the
  journey chooses an available variant. Shopify: product data from `/products/<handle>.js` on
  the page's own origin, or product JSON in the page; the `?variant=` in the URL when
  available, else the first available variant; set through the theme's selects and radio
  swatches (never a quantity field), falling back to the form's hidden `id`. WooCommerce: the
  first variation in stock from `data-product_variations`, set through the attribute selects;
  the answer for a variation is WooCommerce's `show_variation` event when its script is on the
  page (9.8 and later update the button 300 ms after `variation_id`), else the variation id and
  button once they have stayed the same for 600 ms. Without variation data, combinations are
  tried in order (at most 20), each lookup for as long as the step timeout allows. A lookup
  that does not answer in time fails the step as "did not answer within the step timeout", not
  as sold out. Quantity is never changed.
- Step details `variant`, `variantId`, `variantSelectedBy`, `variantSource`,
  `availableVariants` and `totalVariants` on `find_add_to_cart` when a variant was chosen. The
  CLI prints the variant next to the matched control.
- `find_add_to_cart` fails with `No available variant: ...` when every variant is sold out.
- Fixture variants `variants` and `variants-sold-out` for both platforms, and fixture options
  `productEndpoint`, `shopifyVariants`, `variantPickers`, `quantityPicker`, `ajaxVariations`,
  `variationScript`, `wooDefaultAttributes`, `wooInStock`, `wooAttributeInputs`,
  `lockedAddToCart`, `variationLookupDelayMs` and `platformSignals`. The WooCommerce variations
  form runs a jQuery stand-in for WooCommerce's variation script that behaves like 9.8 and
  later; the fixtures package depends on `jquery` to serve it. `pnpm fixtures` starts 14 stores.
- Stale-run sweep in the worker. Runs still `running` `RUN_STALE_AFTER_MS` after they started
  (default 15 minutes, raised when the timeouts allow longer runs) are marked `error` with
  `Worker lost: ...`. Health, failure counts and alerts are not affected. It runs when a worker
  starts and every `HOUSEKEEPING_INTERVAL_MS` (default 5 minutes; `0` turns it off on that
  worker), under a Redis lock so one pass runs at a time. The lock uses its own Redis
  connection, so with Redis down a pass fails and is counted instead of waiting.
- Retention in the same pass. Runs older than `RUN_RETENTION_DAYS` (default 30; `0` keeps
  everything) are deleted in batches with their alert deliveries and artifact directories. Each
  monitor keeps its latest run, the run its status points at and the run behind its latest alert
  of each kind. Artifact directories of deleted monitors are removed too, but only those that
  hold the marker file `.checkout-sentinel-monitor`, which the worker now writes into
  `<ARTIFACTS_DIR>/<monitorId>/` before each run. Directories of monitors deleted before
  upgrading have no marker and stay. `ARTIFACTS_DIR` must belong to one deployment.
- Each run records the BullMQ job it is an attempt of. When BullMQ runs a job again (after a
  stall or an exception), the new attempt marks the job's earlier runs that are still `running`
  as `error` (`Worker lost: BullMQ ran the job again before this run finished`) when it starts.
  A stalled attempt that finishes later cannot apply its older result over the new attempt's,
  even before the sweep would have caught it.
- Worker metrics `checkout_sentinel_runs_swept_total`, `checkout_sentinel_runs_superseded_total`,
  `checkout_sentinel_discarded_results_total`, `checkout_sentinel_runs_deleted_total`,
  `checkout_sentinel_artifact_dirs_deleted_total` and
  `checkout_sentinel_housekeeping_failures_total{task}`.
- Migration `0001_run_housekeeping_indexes` adds indexes on `runs (started_at)` and on
  `runs (started_at)` for running rows. It does not build them `CONCURRENTLY`, so writes to `runs`
  wait while it runs.
- Migration `0002_run_job_id` adds the nullable column `runs.job_id` and a partial index on it
  for running rows. The index is not built `CONCURRENTLY` either. Runs from before the migration
  have no job id; only the sweep finishes those.
- Fixture variant `redirect-to-loopback`.

### Changed

- A browser loading a page (a `GET` whose `Accept` header prefers `text/html`) of a path outside
  `/api`, `/docs`, `/health` and `/metrics` now gets the dashboard instead of the API's JSON
  answer. Requests from scripts and SDKs (`Accept: */*` or `application/json`) are answered as
  before. So the run link in alerts (`PUBLIC_BASE_URL/runs/<id>`) opens the dashboard.
- `pnpm test:unit` also runs the dashboard's tests (the Vitest project `web`).
- A run's final status is written once. A result that arrives after its run was marked lost (by
  the sweep or by a new attempt of its job) or deleted is discarded: no state change, no alert.
  If BullMQ ran the job again, it refuses the late completion and keeps the new attempt's
  outcome; the job outcome is `discarded` only when the same worker still held the job. A worker
  exception no longer overwrites a run that already has a final status.
- The worker stores a run's result and applies it to the monitor's state in one transaction.
- A WooCommerce `.single_add_to_cart_button` with the class `disabled` counts as disabled in
  `find_add_to_cart`, whichever strategy matched it (the generic strategy finds the same button
  by its name). A variable product with no variation chosen used to be clicked, and the journey
  failed later at `verify_cart`.
- A Shopify product whose only variant is sold out now fails `find_add_to_cart` with
  `No available variant: the only variant is sold out` instead of "hidden or disabled".
- Version 0.2.0 in `--version`, the user agent (`checkout-sentinel/0.2.0`), the run result's `tool.version`,
  `GET /health` and the OpenAPI document.
- Local development and tests against fixture stores on 127.0.0.1 need
  `ALLOW_PRIVATE_TARGETS=true` on the API and worker.

### Security

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
- Alert deliveries no longer use `fetch`. A redirect answer is now a final failed delivery
  (`HTTP 302 (redirects are not followed)`) instead of a retried network error.
- The dashboard's `index.html` is served with a Content Security Policy that allows no inline
  or third-party script or style, plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer`. The token entered in the dashboard stays in the tab's
  `sessionStorage` and is sent only as a bearer header to the same origin. Details are in
  [SECURITY.md](SECURITY.md#dashboard).
- `GET /runs/:id/artifacts/:name` needs the API token, serves only plain file names that the
  run's stored result references, looks them up under `ARTIFACTS_DIR/<monitorId>/<runId>/` and
  refuses a file whose real path, symbolic links resolved, is outside `ARTIFACTS_DIR`.

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
