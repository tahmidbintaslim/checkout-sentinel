# checkout-sentinel

Scheduled synthetic checks for Shopify and WooCommerce stores. A real browser opens a product
page, adds the product to the cart, confirms the cart changed and loads the checkout page, on a
desktop and a mobile viewport. If a step fails or gets slow, you get one alert, and one more when
it recovers.

It never enters payment details and never places an order.

[![CI](https://github.com/tahmidbintaslim/checkout-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/tahmidbintaslim/checkout-sentinel/actions/workflows/ci.yml)
License: MIT. Status: v0.2, early.

## Why

Small and mid-size stores that pay for ads can lose sales for hours without noticing when:

- a theme edit hides the "Add to cart" button below a mobile breakpoint,
- an app update ships a script that throws before the theme's cart handler is attached,
- the cart endpoint starts returning errors, or
- a redirect or plugin change breaks the path to checkout.

Uptime monitors miss all of these: the product page still returns 200. The only reliable check
is to do what a shopper does, in a browser, on a schedule.

## What you get

- **Core engine** (`packages/core`): a Playwright journey with six steps, platform detection, a
  versioned JSON result (zod schema) and exit codes.
- **CLI** (`apps/cli`): `checkout-sentinel run <productUrl>` for a one-off check,
  `check` to run a config file once, `init` to write an example config.
- **API and worker** (`apps/api`, `apps/worker`): a NestJS API for monitors, run history and
  status; a BullMQ worker that runs journeys on cron schedules and sends state-change alerts to a
  generic webhook or a Slack incoming webhook. Postgres for state, Redis for the queue.
- **Dashboard** (`apps/web`): a Vue app the API serves at `/`. Monitors and their status, run
  history, step timelines with failure screenshots, Run now, create and edit forms, and the
  alert log. See [Dashboard](#dashboard).
- **docker compose** stack with Postgres, Redis, API (with the dashboard) and worker.

## Quickstart: CLI

Requirements: Node 22.12+, pnpm 11.

```bash
pnpm install
pnpm build
pnpm --filter @checkout-sentinel/core exec playwright install chromium

node apps/cli/dist/main.js run https://your-store.example/products/your-bestseller
```

Options:

```text
checkout-sentinel run <productUrl>
  --platform auto|shopify|woocommerce   default: auto (detected from the page)
  --device desktop|mobile|both          default: both
  --json                                print the result JSON (schema version 1)
  --out <dir>                           result.json, screenshots and traces (default: checkout-sentinel-results)
  --slow-step-ms <ms>                   flag passing steps slower than this (default: 8000)
  --navigation-timeout <ms>             page loads (default: 30000)
  --step-timeout <ms>                   in-page waits (default: 15000)
  --fail-on-page-errors                 fail a step if the page throws during it
  --block-private-targets               refuse private and internal addresses and ports other than
                                        80 and 443, as the worker does (reads ALLOWED_TARGET_HOSTS
                                        and ALLOWED_TARGET_PORTS)

checkout-sentinel init [--path checkout-sentinel.yml] [--force]
checkout-sentinel check [--config checkout-sentinel.yml] [--json] [--out <dir>] [--block-private-targets]
```

The CLI may reach private addresses by default (it runs on your machine, and `localhost` or a
staging server on your network is a normal target). The API and worker refuse them; see
[Outbound URL checks](#outbound-url-checks). `--block-private-targets` applies the worker's
rules, the port rule included. To allow a store on another port, or a single internal host,
set `ALLOWED_TARGET_PORTS` or `ALLOWED_TARGET_HOSTS` as you would for the worker.

Exit codes: `0` every journey passed, `1` a journey failed, `2` bad arguments or config,
`3` the run could not execute (for example Chromium did not start).

### Try it without a real store

The repository includes local fixture stores that imitate a Shopify product page and a
WooCommerce product page, plus broken variants and products with options. Nothing leaves your
machine.

```bash
pnpm fixtures   # starts 14 fixture stores on 127.0.0.1:4010-4023 and prints their URLs
# in another terminal:
node apps/cli/dist/main.js run http://127.0.0.1:4015/product/demo-hoodie/
node apps/cli/dist/main.js run http://127.0.0.1:4011/products/demo-tee --device mobile
node apps/cli/dist/main.js run http://127.0.0.1:4020/products/demo-tee   # size and colour, default sold out
```

### Example output

These are real runs against the fixture stores (paths shortened to
`checkout-sentinel-results/<run-id>/`). A passing WooCommerce-like store:

```text
checkout-sentinel 0.2.0  http://127.0.0.1:4015/product/demo-hoodie/
Platform: woocommerce (high confidence: meta[name="generator"] mentions WooCommerce; wc_add_to_cart_params or woocommerce_params is defined; body has class woocommerce or woocommerce-page; button.single_add_to_cart_button)

desktop  PASSED  881 ms
   ok   open_product         199 ms  HTTP 200, platform woocommerce
   ok   find_add_to_cart     182 ms  button.single_add_to_cart_button
   ok   add_to_cart          143 ms
   ok   verify_cart            9 ms  cart 0 -> 1 (Store API /wp-json/wc/store/v1/cart)
   ok   go_to_checkout        56 ms
   ok   checkout_renders      53 ms  /checkout/

mobile   PASSED  701 ms
   ok   open_product         118 ms  HTTP 200, platform woocommerce
   ok   find_add_to_cart     120 ms  button.single_add_to_cart_button
   ok   add_to_cart          110 ms
   ok   verify_cart            9 ms  cart 0 -> 1 (Store API /wp-json/wc/store/v1/cart)
   ok   go_to_checkout        64 ms
   ok   checkout_renders      51 ms  /checkout/

Result: PASSED  2/2 journeys passed  (1.99 s)
Result JSON: checkout-sentinel-results/<run-id>/result.json
```

A Shopify-like store whose theme hides the button below 750px (exit code 1):

```text
checkout-sentinel 0.2.0  http://127.0.0.1:4011/products/demo-tee
Platform: shopify (high confidence: window.Shopify is defined; meta[name="shopify-checkout-api-token"] or shopify-digital-wallet; Shopify response headers (x-shopid, x-shopify-stage, powered-by: Shopify); form[action*="/cart/add"])

mobile   FAILED  2.84 s
   ok   open_product         151 ms  HTTP 200, platform shopify
  FAIL  find_add_to_cart     2.23 s  Add-to-cart control exists (submit button inside form[action*="/cart/add"]) but is hidden or disabled at this viewport
          screenshot: checkout-sentinel-results/<run-id>/mobile-find_add_to_cart.png
  skip  add_to_cart                  Skipped because find_add_to_cart failed
  skip  verify_cart                  Skipped because find_add_to_cart failed
  skip  go_to_checkout               Skipped because find_add_to_cart failed
  skip  checkout_renders             Skipped because find_add_to_cart failed
          trace: checkout-sentinel-results/<run-id>/mobile-trace.zip (open with: npx playwright show-trace <file>)

Result: FAILED  0/1 journeys passed  (3.29 s)
Result JSON: checkout-sentinel-results/<run-id>/result.json
```

A Shopify-like product with size and colour options whose default variant is sold out. The
journey picks the first available variant through the theme's own pickers:

```text
checkout-sentinel 0.2.0  http://127.0.0.1:4020/products/demo-tee
Platform: shopify (high confidence: window.Shopify is defined; meta[name="shopify-checkout-api-token"] or shopify-digital-wallet; Shopify response headers (x-shopid, x-shopify-stage, powered-by: Shopify); form[action*="/cart/add"])

desktop  PASSED  1.01 s
   ok   open_product         168 ms  HTTP 200, platform shopify
   ok   find_add_to_cart     358 ms  submit button inside form[action*="/cart/add"], variant S / White (theme options)
   ok   add_to_cart          121 ms
   ok   verify_cart            8 ms  cart 0 -> 1 (/cart.js)
   ok   go_to_checkout        64 ms
   ok   checkout_renders      41 ms  /checkouts/cn/fixture-checkout-xyz

Result: PASSED  1/1 journeys passed  (1.39 s)
Result JSON: checkout-sentinel-results/<run-id>/result.json
```

Timings above come from a local fixture server and say nothing about real stores.

## Quickstart: self-hosted with docker compose

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and API_TOKEN
docker compose up -d --build --wait
open http://localhost:3000/       # dashboard; it asks for API_TOKEN
open http://localhost:3000/docs   # OpenAPI UI
```

Create a monitor in the dashboard, or with the API:

```bash
curl -X POST http://localhost:3000/api/monitors \
  -H "authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Bestseller",
    "url": "https://your-store.example/products/your-bestseller",
    "devices": ["mobile", "desktop"],
    "schedule": "*/15 * * * *",
    "alerts": [{ "type": "slack", "url": "https://hooks.slack.com/services/..." }]
  }'
```

Then `GET /api/monitors/{id}/status`, `GET /api/monitors/{id}/runs`, `POST /api/monitors/{id}/runs`
(run now) and `GET /api/runs/{id}` (full result). Prometheus metrics are at `GET /metrics` on the
API and on port 9465 of each worker.

Every API route answers under `/api` and, as in v0.1, without the prefix: `/api/monitors` and
`/monitors` are the same route. The dashboard uses `/api`. The one difference at the old paths: a
browser loading a page (a `GET` whose `Accept` header prefers `text/html`) of a path such as
`/monitors/<id>` or `/runs/<id>` gets the dashboard page for it. Scripts, `curl` and SDKs send
`*/*` or `application/json` and get the API, as before. `/health`, `/metrics` and `/docs` are
always the API.

| Endpoint (also under `/api`)     | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `GET /health`                    | Postgres and Redis reachability (public)                         |
| `GET /metrics`                   | Prometheus metrics (public)                                      |
| `GET /docs`                      | OpenAPI UI; JSON at `/docs/openapi.json`                         |
| `GET/POST /monitors`             | List with latest status, create                                  |
| `GET/PATCH/DELETE /monitors/:id` | Read, partial update, delete                                     |
| `GET /monitors/:id/status`       | Health, last run, consecutive failures                           |
| `GET /monitors/:id/runs`         | History, newest first, `?limit=&before=`                         |
| `POST /monitors/:id/runs`        | Queue a run now (202)                                            |
| `GET /monitors/:id/alerts`       | Alert delivery log of one monitor                                |
| `GET /alerts`                    | Alert delivery log of all monitors, `?monitorId=&limit=&before=` |
| `GET /runs/:id`                  | One run with its full result JSON and its artifact files         |
| `GET /runs/:id/artifacts/:name`  | A screenshot (PNG) or trace (zip) the run's result names         |

Slack URLs are masked and webhook secrets are never returned. To keep a saved channel when you
`PATCH` the `alerts` list, send `{ "type": "stored", "index": <its position in alerts> }` in its
place, and the monitor's `updatedAt` from the same read as `expectedUpdatedAt`, for example
`"alerts": [{ "type": "stored", "index": 0 }, { "type": "webhook", "url": "..." }], "expectedUpdatedAt": "2026-10-26T10:00:00.000Z"`.
If the monitor changed after that read, the API answers 409 and writes nothing: read it again and
resend the change. Any `PATCH` may carry `expectedUpdatedAt`.

### Outbound URL checks

Monitor URLs, webhook URLs and Slack URLs are fetched by your servers, so the API and worker
refuse ones that point at internal addresses: loopback, private networks, link-local (including
the cloud metadata address `169.254.169.254`), unique-local IPv6 and other reserved ranges,
directly or through DNS. Ports other than 80 and 443, and credentials in URLs, are refused too.
Slack channel URLs must start with `https://hooks.slack.com/`. The API answers 400; the worker
checks again before every run and every alert, and the journey's browser can only connect to
public addresses, so a store cannot redirect it to an internal host.

To monitor a store running on your own machine or network (for example the fixture stores),
set `ALLOW_PRIVATE_TARGETS=true` on both the API and the worker. Do not do that where other
people can create monitors. `ALLOWED_TARGET_HOSTS` and `ALLOWED_TARGET_PORTS` allow single
internal hosts or extra ports instead. Details are in [SECURITY.md](SECURITY.md#ssrf-protection).

### Run history and stuck runs

Workers clean up after themselves. When a worker starts, and every 5 minutes after that, one
worker at a time (a Redis lock decides) runs a housekeeping pass:

- Runs still `running` 15 minutes after they started are marked `error` with
  `Worker lost: ...`. That happens when a worker dies mid-run. Usually BullMQ runs the job again
  sooner, and the new run marks the old one lost as soon as it starts. A lost run changes neither
  the monitor's health nor its alerts. If the old worker was only paused and finishes later, its
  result is discarded.
- Runs older than 30 days are deleted in batches, with their alert log rows, screenshots and
  traces. Each monitor keeps its latest run, the run its status points at and the runs behind
  its latest alerts.

| Variable                   | Default                            | Meaning                                                                                                                |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `RUN_STALE_AFTER_MS`       | 15 minutes, more for long timeouts | A run still `running` this long after it started is marked lost.                                                       |
| `RUN_RETENTION_DAYS`       | `30`                               | Days of run history to keep. `0` keeps everything.                                                                     |
| `HOUSEKEEPING_INTERVAL_MS` | `300000`                           | How often each worker tries a pass, at most `2147483647` (about 24.8 days). `0` turns housekeeping off on that worker. |

Counts are in the worker metrics (`checkout_sentinel_runs_swept_total`,
`checkout_sentinel_runs_deleted_total` and others). The rules, including what happens when a
lost run finishes after all, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#housekeeping-stuck-runs-and-retention).

## Dashboard

The API serves the dashboard at `/` (the `apps/web` build; `pnpm build` and the api Docker image
include it). It talks to the API under `/api` on the same origin, so no CORS setup is needed.

![Monitors list in light mode: five monitors with status, platform, devices, schedule, last run and counts](docs/images/dashboard-monitors-light.png)

![Monitor detail in dark mode: a failing monitor with its latest result by device, run history and Run now](docs/images/dashboard-monitor-dark.png)

![Run detail in light mode: the mobile journey's step timeline, the failure message and the screenshot taken when the step failed](docs/images/dashboard-run-light.png)

These screenshots are real runs against the local fixture stores, taken with
`pnpm --filter @checkout-sentinel/web screenshots` (after `pnpm build`; it empties the e2e test
database and Redis DB).

- **Monitors**: name and URL, platform, devices, schedule, health, last run, failed runs in a
  row and slow steps.
- **Monitor**: latest result per device, run history (10 per page), Run now, edit and delete.
  After Run now the page refreshes every 2 seconds until the run finishes.
- **Run**: per device, each step with its status, duration and position in the journey, the
  failure message, console errors, page errors, failed requests, step details, the failure
  screenshot and a trace download.
- **Create and edit**: the form checks input with the API's own schema
  (`@checkout-sentinel/core/schemas`), so it accepts and refuses what the API does. Saved Slack
  URLs and webhook secrets are shown masked and kept unless you remove the channel.
- **Alert log**: every delivery, newest first, filterable by monitor.

When the API has `API_TOKEN`, the dashboard asks for it once per browser tab. It keeps the token
in the tab's `sessionStorage` and sends it as a bearer token; closing the tab forgets it. Pages
follow the system's light or dark setting. Controls are native buttons, links and labelled form
fields with a visible focus ring, and text meets WCAG AA contrast in both modes.

Alert messages link to `PUBLIC_BASE_URL/runs/<runId>`. Set `PUBLIC_BASE_URL` on the worker to
the address of the API (for example `https://sentinel.example.com`) and the link opens the run in
the dashboard.

Settings on the API:

| Variable            | Default                                  | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHBOARD_ENABLED` | `true`                                   | `false` serves the API only.                                                                                                             |
| `DASHBOARD_DIR`     | `apps/web/dist`                          | Directory of the built dashboard. The Docker image sets `/app/web`. Without an `index.html` there, the API starts without the dashboard. |
| `ARTIFACTS_DIR`     | `./artifacts` (image: `/data/artifacts`) | The workers' artifacts directory, read for screenshots and traces. Mount the same volume on the API, read-only is enough.                |

To work on the dashboard, run the API on port 3000 and start Vite, which forwards `/api` to it
(`CHECKOUT_SENTINEL_API_URL` changes the target):

```bash
pnpm --filter @checkout-sentinel/web dev   # http://localhost:5173
```

## Architecture

```mermaid
flowchart LR
  browser([Browser]) -->|dashboard at /,<br/>API under /api| api[API<br/>NestJS]
  user([Script]) -->|REST + bearer token| api
  cli([CLI]) --> core
  api -->|monitors, runs, state| pg[(Postgres)]
  api -->|job schedulers<br/>one per monitor| redis[(Redis<br/>BullMQ)]
  redis -->|journey jobs| worker[Worker<br/>BullMQ]
  worker --> core[core engine<br/>Playwright]
  core -->|Chromium, one context<br/>per journey| store[(Store<br/>Shopify / WooCommerce)]
  worker -->|results, state machine| pg
  worker -->|screenshots, traces| files[(Artifacts<br/>volume)]
  api -.->|reads| files
  worker -->|state changes only| alerts[Webhook / Slack]
  prom([Prometheus]) -.->|/metrics| api
  prom -.->|:9465/metrics| worker
```

More detail, including the data model, job flow, failure handling and scaling notes, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How a journey works

Each device runs the same six steps in a fresh browser context (clean cookies, empty cart).
Devices run one after another, never in parallel against the same store.

| Step               | Passes when                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `open_product`     | The product URL answers below 400 and is not the Shopify `/password` page                                                      |
| `find_add_to_cart` | An available variant is chosen if the product has options, then a visible, enabled add-to-cart control exists at this viewport |
| `add_to_cart`      | It was clicked, and the cart request (if one was seen) did not return 4xx/5xx                                                  |
| `verify_cart`      | The cart's item count went up                                                                                                  |
| `go_to_checkout`   | The checkout path answers below 400                                                                                            |
| `checkout_renders` | The final URL is a checkout URL (not the cart) and a checkout form or email field is visible                                   |

For every step the result records status, duration, console errors, uncaught page exceptions and
failed requests (4xx/5xx responses, blocked and network failures). A failed step gets a
screenshot, and a failed journey keeps its Playwright trace. Steps after a failure are reported as
`skipped`.

### Platform detection

Detection reads signals from the product page and its response headers and scores them:

| Signal                                                                                          | Platform    | Weight |
| ----------------------------------------------------------------------------------------------- | ----------- | ------ |
| `window.Shopify`, `shopify-checkout-api-token` meta, `x-shopid` / `powered-by: Shopify` headers | Shopify     | 3      |
| Assets from `cdn.shopify.com`                                                                   | Shopify     | 2      |
| `form[action*="/cart/add"]`                                                                     | Shopify     | 1      |
| `generator` meta mentioning WooCommerce, `wc_add_to_cart_params` / `woocommerce_params`         | WooCommerce | 3      |
| Body class `woocommerce`, assets under `/plugins/woocommerce/`                                  | WooCommerce | 2      |
| `button.single_add_to_cart_button`                                                              | WooCommerce | 1      |

The higher score wins if it reaches 2 and there is no tie; otherwise the platform is `unknown`.
A single markup signal is never enough, because themes copy markup. You can always override
detection with `--platform` or the monitor's `platform` field.

### Selectors and cart checks

| Platform    | Add to cart (in order)                                                           | Cart verified with                                            | Checkout                           |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Shopify     | submit button in `form[action*="/cart/add"]`, then `[name="add"]`                | `/cart.js` `item_count`                                       | `/checkout`, then `/checkouts/...` |
| WooCommerce | `button.single_add_to_cart_button`, then `a[href*="add-to-cart="]`               | Store API `/wp-json/wc/store/v1/cart`, then the `/cart/` page | `/checkout/`                       |
| any         | a button whose accessible name starts with "Add to cart/bag/basket" or "Buy now" | not verified (step is `skipped`)                              | `/checkout`                        |

### Variant selection

Many products cannot be added as the page first shows them: the theme wants a size chosen
first, or the variant it selects by default is sold out, so the add-to-cart button stays
disabled. Before it looks for the button, `find_add_to_cart` chooses a variant the way a shopper
would.

Shopify:

- Product data comes from `/products/<handle>.js` (the AJAX product endpoint, keeping the page's
  locale prefix), or from product JSON in a `<script type="application/json">` on the page when
  the endpoint does not answer. The endpoint is always read from the page's own origin: a page
  path that would point it at another host (one that starts with `//`) is not used. It is read
  with the journey's request client, so with the SSRF guard on it goes through the egress proxy
  like the browser's own requests, redirect hops included.
- The variant is the one in the URL's `?variant=` when that one is available, else the first
  variant with `available: true`.
- Each option is set through the theme's own select or radio swatch, found by the option's name
  (`options[Size]`, `Size-1`), its label or legend, its position, and last by value alone. A
  radio is set by clicking its label. Quantity fields (named `quantity` or `qty`, or inside a
  `.quantity`, `quantity-input` or `quantity-selector` element) and the variant `id` field are
  never used as options, so a quantity-break radio with the value `2` is not taken for a
  "Pack: 2" option. The journey then checks that the form's `id` field moved to the chosen
  variant.
- If no matching inputs are found, or the theme does not move the `id`, the hidden
  `input[name="id"]` of the product's `/cart/add` form is set directly.

WooCommerce:

- Variation data comes from `data-product_variations` on `form.variations_form`. The first
  variation that is in stock, purchasable, active and visible is chosen; an "any" attribute takes
  the first option the form offers.
- Each attribute select is set in turn, then the journey waits for WooCommerce's answer for that
  variation. WooCommerce 9.8 and later fill `variation_id` at once but update the button 300 ms
  later, so for that time the button still describes the previous variation. With WooCommerce's
  script on the page (jQuery and `jQuery.fn.wc_variation_form`), the answer is its
  `show_variation` event for the variation in `variation_id`: in stock when the event says the
  variation is purchasable and the button is enabled after it. A theme with its own script has
  no such event, and none comes when the form already shows the chosen attributes; there the
  answer is the variation id and the button once both have stayed the same for 600 ms.
- For products with many variations WooCommerce writes `false` instead of the data and asks the
  store for each combination. The journey then tries combinations in page order, at most 20,
  until one resolves in stock. Each lookup may take as long as the step timeout allows, since a
  slow store is not a sold out one. The step fails with `No available variant` only when every
  combination answered out of stock; when the lookup did not answer in time it fails with
  `The variation lookup did not answer within the step timeout (...)`.

Detection of an unknown platform does not stop this: a page with `form.variations_form` is
treated as WooCommerce and a page with a `/cart/add` form as Shopify.

The step's details record the choice: `variant` (for example `S / White` or
`Size: Small, Color: Grey`), `variantId`, `variantSelectedBy` (`theme options`,
`already selected`, `hidden input` or `not applied`), `variantSource`, and the counts
`availableVariants` and `totalVariants` when the product data lists them. The CLI prints the
variant next to the matched control. When every variant is sold out the step fails with
`No available variant: all 4 variants are sold out` (WooCommerce: `variations are out of stock`)
and nothing is added to the cart. A product with a single variant needs no choice and its
details stay as before.

Quantity is never changed: the journey leaves the quantity field at the page's default, which is
1 on standard themes.

On WooCommerce, a `.single_add_to_cart_button` with the class `disabled` counts as disabled,
whichever selector found it (the generic one finds the same button by its name, "Add to cart").
WooCommerce keeps the button of a variable product enabled for the browser and refuses the
click in its own script until a variation in stock is chosen, so a click would otherwise do
nothing and the journey would fail later at `verify_cart`.

### Being polite to the store

- One fresh browser context per journey; devices run in sequence.
- The user agent keeps a normal browser prefix (so mobile themes still serve mobile markup) and
  appends `checkout-sentinel/0.2.0 (+https://github.com/tahmidbintaslim/checkout-sentinel)`, or
  your own URL via `USER_AGENT_CONTACT_URL`, so merchants can filter this traffic.
- Schedules shorter than every 5 minutes are rejected.
- The worker allows one journey per store host at a time across all workers by default
  (`PER_STORE_CONCURRENCY`).
- Nothing on the checkout page is filled or clicked. On top of that, every non-GET request to
  known order placement and payment endpoints (Shopify checkout completion, WooCommerce
  `wc-ajax=checkout` and Store API checkout, Stripe and PayPal confirmation calls) is aborted in
  the browser and recorded as `blocked`.

## Alerting

Alerts follow state changes, not individual results:

- **failure**: after `alertAfterFailures` consecutive failed runs (default 2, which filters
  one-off network blips). Nothing more while it stays broken.
- **recovery**: on the first passing run after a failure alert.
- **slow**: when a passing step crosses `slowStepMs` (default 8000) for the first time; again only
  after it went back under the threshold.
- Runs that could not execute (browser crash, invalid URL) change nothing.

Each delivery is recorded in Postgres with a unique key per run, kind and channel, so a retried
job never sends the same alert twice. Generic webhooks receive a versioned JSON body
(`event: "checkout_sentinel.alert"`) and, when a `secret` is configured, an
`x-checkout-sentinel-signature: sha256=<hmac>` header over the raw body.

## Development

```bash
pnpm install
pnpm lint            # ESLint + Prettier check
pnpm typecheck       # strict TypeScript across the workspace
pnpm test:unit       # no browser, no services; includes the dashboard's component tests
pnpm test:integration  # engine and CLI against local fixture stores (needs Chromium)
pnpm test:e2e        # API, worker and dashboard against Postgres and Redis; skipped if unreachable
pnpm build
```

The e2e tests read `TEST_DATABASE_URL` and `TEST_REDIS_URL` (defaults:
`postgres://sentinel:sentinel@127.0.0.1:5432/checkout_sentinel_test` and
`redis://127.0.0.1:6379/15`). If either is unreachable they are skipped and the reason is printed.
If Playwright cannot find its own Chromium (for example in a sandbox with a different browser
build), point `CHECKOUT_SENTINEL_CHROMIUM_PATH` at a Chromium binary.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## Limitations

- Only one variant is checked per journey: the first available one, or the one in a Shopify
  `?variant=` URL. To watch a particular variant on Shopify, put its `?variant=<id>` in the
  monitor URL. On WooCommerce the first variation in stock is chosen even when the URL
  preselects attributes (`?attribute_pa_size=...`).
- Variant pickers are recognised when they are selects or radio inputs (swatches built on
  radios included). Pickers made of other elements, or inside a shadow DOM, fall back to
  setting the form's hidden variant `id`. A theme that keeps its button disabled until its own
  picker is used then fails at `find_add_to_cart` with "hidden or disabled".
- Setting the hidden `id` can pass where a shopper would fail, for example when the theme's
  picker script is broken but its button stays enabled. `variantSelectedBy: hidden input` in
  the step details shows when that happened.
- WooCommerce products whose variations load over AJAX are tried at most 20 combinations
  deep. If none of those is in stock the step fails with
  `No available variant among the first 20 of N option combinations`, even if a later one is.
  Each combination takes at least WooCommerce's 300 ms plus the store's lookup time, so a long
  search needs a step timeout to match.
- WooCommerce attributes are set through the variations form's attribute selects (swatch
  plugins keep them, hidden, and the journey sets them directly). A theme that draws attributes
  without selects is not handled: its button keeps the class `disabled` and the step fails with
  "hidden or disabled".
- Product add-ons, personalisation fields, bundles and subscriptions that require input
  before add to cart are not filled in.
- Stores behind bot protection, a password page, a geo redirect or a CAPTCHA will fail or be
  blocked. That is a real result for shoppers too, but it may not be what you want to monitor.
- The checkout check stops at "the page renders with a form". It does not test shipping rates,
  discount codes, payment providers or order placement.
- Headless storefronts (Hydrogen, custom Next.js) work only through the generic fallback, and
  their cart is not verified.
- Each run adds an item to a real cart. The session is discarded afterwards, but some
  abandoned-cart or analytics tools may count it. Filter on the user agent.
- The API has a single static bearer token. There are no users, teams or roles yet. Anyone
  with the token can see and change every monitor, in the dashboard as with the API.
- The dashboard shows screenshots and offers traces only when the API can read the workers'
  `ARTIFACTS_DIR`. With separate machines, mount one shared volume on the API and the workers.
- Alert channels are a generic webhook and Slack. Email and SMS are not built in.
- Retention deletes artifact files only from the disk of the worker that runs the pass. Workers
  need one shared artifacts volume (the compose stack has one) for old screenshots and traces to
  be removed.
- `ARTIFACTS_DIR` must belong to one deployment. Two deployments with separate databases must
  not share it, and it should not be a directory other software uses, such as `/tmp`. Retention
  removes only directories the worker marked as its own, but it treats every marked directory
  of a monitor missing from its database as a deleted monitor's.

## Roadmap

- A hosted version with accounts and per-account API keys, built on the dashboard
- Shopify app for one-click setup on a store
- OpenTelemetry export of runs and steps
- More platforms: BigCommerce, Magento (Adobe Commerce), Wix, Squarespace
- Custom journeys (log in, apply a discount code, check a chosen variant on WooCommerce)
- More alert channels (email, Microsoft Teams, PagerDuty)

## License

[MIT](LICENSE). Copyright (c) 2026 Tahmid Bin Taslim Rafi.
