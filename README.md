# checkout-sentinel

Scheduled synthetic checks for Shopify and WooCommerce stores. A real browser opens a product
page, adds the product to the cart, confirms the cart changed and loads the checkout page, on a
desktop and a mobile viewport. If a step fails or gets slow, you get one alert, and one more when
it recovers.

It never enters payment details and never places an order.

[![CI](https://github.com/tahmidbintaslim/checkout-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/tahmidbintaslim/checkout-sentinel/actions/workflows/ci.yml)
License: MIT. Status: v0.1, early.

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
- **docker compose** stack with Postgres, Redis, API and worker.

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
WooCommerce product page, plus broken variants. Nothing leaves your machine.

```bash
pnpm fixtures   # starts 10 fixture stores on 127.0.0.1:4010-4019 and prints their URLs
# in another terminal:
node apps/cli/dist/main.js run http://127.0.0.1:4015/product/demo-hoodie/
node apps/cli/dist/main.js run http://127.0.0.1:4011/products/demo-tee --device mobile
```

### Example output

These are real runs against the fixture stores. A passing WooCommerce-like store:

```text
checkout-sentinel 0.1.0  http://127.0.0.1:4015/product/demo-hoodie/
Platform: woocommerce (high confidence: meta[name="generator"] mentions WooCommerce; wc_add_to_cart_params or woocommerce_params is defined; body has class woocommerce or woocommerce-page; button.single_add_to_cart_button)

desktop  PASSED  640 ms
   ok   open_product         117 ms  HTTP 200, platform woocommerce
   ok   find_add_to_cart      70 ms  button.single_add_to_cart_button
   ok   add_to_cart          126 ms
   ok   verify_cart           11 ms  cart 0 -> 1 (Store API /wp-json/wc/store/v1/cart)
   ok   go_to_checkout        55 ms
   ok   checkout_renders      37 ms  /checkout/

mobile   PASSED  516 ms
   ok   open_product          89 ms  HTTP 200, platform woocommerce
   ok   find_add_to_cart      52 ms  button.single_add_to_cart_button
   ok   add_to_cart           87 ms
   ok   verify_cart           11 ms  cart 0 -> 1 (Store API /wp-json/wc/store/v1/cart)
   ok   go_to_checkout        54 ms
   ok   checkout_renders      33 ms  /checkout/

Result: PASSED  2/2 journeys passed  (1.48 s)
```

A Shopify-like store whose theme hides the button below 750px (exit code 1):

```text
checkout-sentinel 0.1.0  http://127.0.0.1:4011/products/demo-tee
Platform: shopify (high confidence: window.Shopify is defined; meta[name="shopify-checkout-api-token"] or shopify-digital-wallet; Shopify response headers (x-shopid, x-shopify-stage, powered-by: Shopify); form[action*="/cart/add"])

mobile   FAILED  2.54 s
   ok   open_product         121 ms  HTTP 200, platform shopify
  FAIL  find_add_to_cart     2.11 s  Add-to-cart control exists (submit button inside form[action*="/cart/add"]) but is hidden or disabled at this viewport
          screenshot: checkout-sentinel-results/<run-id>/mobile-find_add_to_cart.png
  skip  add_to_cart                  Skipped because find_add_to_cart failed
  skip  verify_cart                  Skipped because find_add_to_cart failed
  skip  go_to_checkout               Skipped because find_add_to_cart failed
  skip  checkout_renders             Skipped because find_add_to_cart failed
          trace: checkout-sentinel-results/<run-id>/mobile-trace.zip (open with: npx playwright show-trace <file>)

Result: FAILED  0/1 journeys passed  (2.83 s)
```

Timings above come from a local fixture server and say nothing about real stores.

## Quickstart: self-hosted with docker compose

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and API_TOKEN
docker compose up -d --build --wait
open http://localhost:3000/docs   # OpenAPI UI
```

Create a monitor:

```bash
curl -X POST http://localhost:3000/monitors \
  -H "authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Bestseller",
    "url": "https://your-store.example/products/your-bestseller",
    "devices": ["mobile", "desktop"],
    "schedule": "*/15 * * * *",
    "alerts": [{ "type": "slack", "url": "https://hooks.slack.com/services/..." }]
  }'
```

Then `GET /monitors/{id}/status`, `GET /monitors/{id}/runs`, `POST /monitors/{id}/runs` (run now)
and `GET /runs/{id}` (full result). Prometheus metrics are at `GET /metrics` on the API and on
port 9465 of each worker.

| Endpoint                         | Purpose                                  |
| -------------------------------- | ---------------------------------------- |
| `GET /health`                    | Postgres and Redis reachability (public) |
| `GET /metrics`                   | Prometheus metrics (public)              |
| `GET /docs`                      | OpenAPI UI; JSON at `/docs/openapi.json` |
| `GET/POST /monitors`             | List with latest status, create          |
| `GET/PATCH/DELETE /monitors/:id` | Read, partial update, delete             |
| `GET /monitors/:id/status`       | Health, last run, consecutive failures   |
| `GET /monitors/:id/runs`         | History, newest first, `?limit=&before=` |
| `POST /monitors/:id/runs`        | Queue a run now (202)                    |
| `GET /monitors/:id/alerts`       | Alert delivery log                       |
| `GET /runs/:id`                  | One run with its full result JSON        |

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
  `Worker lost: ...`. That happens when a worker dies mid-run; BullMQ then runs the job again as
  a new run. A lost run changes neither the monitor's health nor its alerts. If the old worker
  was only paused and finishes later, its result is discarded.
- Runs older than 30 days are deleted in batches, with their alert log rows, screenshots and
  traces. Each monitor keeps its latest run, the run its status points at and the runs behind
  its latest alerts.

| Variable                   | Default                            | Meaning                                                                        |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `RUN_STALE_AFTER_MS`       | 15 minutes, more for long timeouts | A run still `running` this long after it started is marked lost.               |
| `RUN_RETENTION_DAYS`       | `30`                               | Days of run history to keep. `0` keeps everything.                             |
| `HOUSEKEEPING_INTERVAL_MS` | `300000`                           | How often each worker tries a pass. `0` turns housekeeping off on that worker. |

Counts are in the worker metrics (`checkout_sentinel_runs_swept_total`,
`checkout_sentinel_runs_deleted_total` and others). The rules, including what happens when a
lost run finishes after all, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#housekeeping-stuck-runs-and-retention).

## Architecture

```mermaid
flowchart LR
  user([Merchant or script]) -->|REST + bearer token| api[API<br/>NestJS]
  cli([CLI]) --> core
  api -->|monitors, runs, state| pg[(Postgres)]
  api -->|job schedulers<br/>one per monitor| redis[(Redis<br/>BullMQ)]
  redis -->|journey jobs| worker[Worker<br/>BullMQ]
  worker --> core[core engine<br/>Playwright]
  core -->|Chromium, one context<br/>per journey| store[(Store<br/>Shopify / WooCommerce)]
  worker -->|results, state machine| pg
  worker -->|state changes only| alerts[Webhook / Slack]
  prom([Prometheus]) -.->|/metrics| api
  prom -.->|:9465/metrics| worker
```

More detail, including the data model, job flow, failure handling and scaling notes, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How a journey works

Each device runs the same six steps in a fresh browser context (clean cookies, empty cart).
Devices run one after another, never in parallel against the same store.

| Step               | Passes when                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `open_product`     | The product URL answers below 400 and is not the Shopify `/password` page                    |
| `find_add_to_cart` | A visible, enabled add-to-cart control exists at this viewport                               |
| `add_to_cart`      | It was clicked, and the cart request (if one was seen) did not return 4xx/5xx                |
| `verify_cart`      | The cart's item count went up                                                                |
| `go_to_checkout`   | The checkout path answers below 400                                                          |
| `checkout_renders` | The final URL is a checkout URL (not the cart) and a checkout form or email field is visible |

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

### Being polite to the store

- One fresh browser context per journey; devices run in sequence.
- The user agent keeps a normal browser prefix (so mobile themes still serve mobile markup) and
  appends `checkout-sentinel/0.1.0 (+https://github.com/tahmidbintaslim/checkout-sentinel)`, or
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
pnpm test:unit       # no browser, no services
pnpm test:integration  # engine and CLI against local fixture stores (needs Chromium)
pnpm test:e2e        # API and worker against Postgres and Redis; skipped if unreachable
pnpm build
```

The e2e tests read `TEST_DATABASE_URL` and `TEST_REDIS_URL` (defaults:
`postgres://sentinel:sentinel@127.0.0.1:5432/checkout_sentinel_test` and
`redis://127.0.0.1:6379/15`). If either is unreachable they are skipped and the reason is printed.
If Playwright cannot find its own Chromium (for example in a sandbox with a different browser
build), point `CHECKOUT_SENTINEL_CHROMIUM_PATH` at a Chromium binary.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## Limitations

- Only the first variant is added; products that need an option chosen first (size, colour
  without a default) fail at `find_add_to_cart` or `verify_cart`.
- Stores behind bot protection, a password page, a geo redirect or a CAPTCHA will fail or be
  blocked. That is a real result for shoppers too, but it may not be what you want to monitor.
- The checkout check stops at "the page renders with a form". It does not test shipping rates,
  discount codes, payment providers or order placement.
- Headless storefronts (Hydrogen, custom Next.js) work only through the generic fallback, and
  their cart is not verified.
- Each run adds an item to a real cart. The session is discarded afterwards, but some
  abandoned-cart or analytics tools may count it. Filter on the user agent.
- The API has a single static bearer token. There are no users, teams or roles yet.
- Alert channels are a generic webhook and Slack. Email and SMS are not built in.
- Retention deletes artifact files only from the disk of the worker that runs the pass. Workers
  need one shared artifacts volume (the compose stack has one) for old screenshots and traces to
  be removed.

## Roadmap

- Hosted dashboard with run history, screenshots and traces in the browser
- Shopify app for one-click setup on a store
- OpenTelemetry export of runs and steps
- More platforms: BigCommerce, Magento (Adobe Commerce), Wix, Squarespace
- Variant selection and custom journeys (log in, apply a discount code)
- More alert channels (email, Microsoft Teams, PagerDuty)

## License

[MIT](LICENSE). Copyright (c) 2026 Tahmid Bin Taslim Rafi.
