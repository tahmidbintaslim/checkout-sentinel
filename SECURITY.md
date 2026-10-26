# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub security advisories](https://github.com/tahmidbintaslim/checkout-sentinel/security/advisories/new)
rather than a public issue. Include steps to reproduce and the version or commit. You should get
an acknowledgement within a few days. This is a small open-source project with no bug bounty.

## Supported versions

Only the latest release receives fixes while the project is in 0.x.

## Things to know when self-hosting

- **Set `API_TOKEN`.** Without it the API accepts unauthenticated requests, and anyone who can
  open the dashboard can see and change every monitor. `/health`, `/metrics`, `/docs` and the
  dashboard's static files are always public (the files hold no data); do not expose the API to
  the internet without a token and TLS in front of it.
- **Monitor and webhook URLs are fetched by your servers.** The API and worker refuse URLs that
  point at private and internal addresses (see [SSRF protection](#ssrf-protection) below).
  Leave `ALLOW_PRIVATE_TARGETS` off in production. The guard is one layer: still run workers in
  a network segment that cannot reach internal systems.
- **Webhook URLs are credentials.** Slack webhook URLs are masked in API responses and webhook
  secrets are never returned, but both are stored in plain text in Postgres. Protect database
  access and backups accordingly.
- **Verify webhook signatures.** If you set a `secret` on a webhook channel, check the
  `x-checkout-sentinel-signature` header (`sha256=` HMAC of the raw body) before trusting a
  delivery.
- **Artifacts may contain store content.** Failure screenshots and traces capture the pages the
  journey visited, including cookies in traces. Treat the artifacts volume as sensitive. The API
  serves them to holders of the API token (see [Dashboard](#dashboard)).
- **The journey never pays.** It does not fill or submit checkout forms, and order placement and
  payment requests are blocked in the browser. If you find a way it could place an order, please
  report it as a security issue.

## Dashboard

The API serves the dashboard at `/`. What it does to keep the token and the data safe:

- **Token storage.** The token entered in the dashboard is kept in `sessionStorage` for that tab
  and sent only as an `Authorization: Bearer` header to the same origin. It is not written to
  `localStorage` or a cookie, so it does not outlive the tab and is not sent with requests
  automatically, which also rules out cross-site request forgery. Script running in the page
  could read it, which is why the page allows no other script (next point).
- **Content Security Policy.** `index.html` is served with `default-src 'self'`,
  `script-src 'self'` and `style-src 'self'` (no inline scripts or styles), `img-src 'self'
blob: data:`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'` and `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Store content (names,
  URLs, step messages, console errors) is rendered as text by Vue, never as HTML.
- **Artifacts.** `GET /runs/:id/artifacts/:name` needs the token like every other API route. It
  serves only file names the run's stored result references, accepts only plain names (no
  separators or leading dots), looks them up under `ARTIFACTS_DIR/<monitorId>/<runId>/` and
  refuses any file whose real path, after resolving symbolic links, is outside `ARTIFACTS_DIR`.
  The compose stack mounts the artifacts volume read-only on the API.
- **Secrets.** Saved Slack URLs are shown masked and webhook secrets are never sent to the
  browser. An edit keeps them with a stored channel reference instead of sending them back.

## SSRF protection

Anyone who can create a monitor chooses URLs that your servers fetch: the product URL (loaded
by the worker's browser), webhook URLs and Slack URLs (posted to by the worker). Without
checks, that is server-side request forgery: a monitor could point the browser at a cloud
metadata endpoint or an internal admin page, and the failure screenshot would capture it.

### What is refused

A URL is refused when any of these is true:

- The scheme is not `http` or `https`, or the URL contains a user name or password.
- The port is not 80 or 443 and is not listed in `ALLOWED_TARGET_PORTS`.
- The host is `localhost` or ends in `.localhost`.
- The host is an IP address, or a name that resolves to one, in any of these ranges: loopback
  (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
  carrier-grade NAT (`100.64.0.0/10`), link-local (`169.254.0.0/16` including the metadata
  address `169.254.169.254`, `fe80::/10`), unique-local IPv6 (`fc00::/7`, which includes
  `fd00:ec2::254`), IPv4-mapped IPv6 (`::ffff:0:0/96`, whatever it maps to), multicast,
  unspecified (`0.0.0.0`, `::`), and the other reserved and documentation ranges from the
  IANA special-purpose registries. NAT64 and 6to4 addresses are judged by the IPv4 address
  they carry. IPv6 outside `2000::/3` is refused.
- A name resolves to several addresses and any one of them is in those ranges.
- For Slack channels: the URL does not start with `https://hooks.slack.com/`.

IPv4 hosts are read the way browsers read them, so `2130706433`, `0x7f.1` and `0177.0.0.1` are
all `127.0.0.1`.

A refusal for a name says only that it resolves to a private or internal address. The address
and its range are not in API errors, run errors, step messages and details, or the `Blocked:`
errors of alert deliveries, so the guard cannot be used to read where internal names point.
Connection failures during a journey are reported by kind
(for example `the connection was refused`), without the address that was dialled. The API and
the worker log the resolved address and range at debug level.

### When it is checked

| When                         | Where                             | Result when refused                                                                         |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST` and `PATCH /monitors` | API, with DNS                     | 400 with one issue per refused URL (`url`, `alerts.1.url`)                                  |
| Before each run              | worker, with DNS                  | Run stored as `error` with `Target blocked: ...`; no alert                                  |
| During the journey           | egress proxy, on every connection | Listed in step details; a refused navigation fails the step with `Blocked a request to ...` |
| Before each alert delivery   | worker, on the connection         | Delivery recorded as `failed` with `Blocked: ...`; not retried                              |

The use-time checks matter because DNS answers change. The API check is early feedback; a
name that does not resolve yet is accepted there, because nothing can connect to it, and is
checked again before every use.

During a journey the browser context sends all of its traffic through a small proxy inside the
worker process. Playwright route handlers are not called for redirect hops, so routing alone
cannot stop a public store from redirecting the browser to an internal address; the proxy sees
every connection: navigations, each redirect hop, frames, scripts, images and the cart API
reads. HTTPS goes through `CONNECT` tunnels, so TLS stays between Chromium and the store.
Every refused connection is listed in the step's `details.blockedRequests`. A refused
navigation or redirect hop fails the step, and the message names it. A refused image, script
or frame does not fail the step on its own; if the step fails for another reason, it keeps its
own message.

The proxy and alert deliveries resolve the name themselves and connect to the address they
just checked. A name cannot answer with a public address to the check and a private one to the
connection (DNS rebinding). Alert deliveries never follow redirects; a 3xx answer is recorded
as a failed delivery.

### Settings

The API and the worker read the same variables. Set them to the same values on both.

| Variable                | Default | Meaning                                                                                                                                                                                              |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_PRIVATE_TARGETS` | `false` | `true` turns off the address, port and Slack host checks (scheme and credential checks stay). For local development and tests against the fixture stores only. Both services log a warning at start. |
| `ALLOWED_TARGET_HOSTS`  | empty   | Comma-separated host names or IP addresses, matched exactly, that may resolve to private addresses. For example an internal alert relay. The port rule still applies.                                |
| `ALLOWED_TARGET_PORTS`  | empty   | Comma-separated ports allowed besides 80 and 443.                                                                                                                                                    |

`docker-compose.yml` and `.env.example` set `ALLOW_PRIVATE_TARGETS=false`.

### The CLI

The CLI allows private targets by default. It runs on your own machine, against URLs you typed
or a config file you wrote, and checking a store on `localhost`, a fixture store or a staging
server on a private network is a normal use. Pass `--block-private-targets` to `run` or
`check` to apply the same guard as the worker, for example in CI against a config file that
other people can change. With the flag, the port rule applies too (only 80 and 443), and the
CLI reads `ALLOWED_TARGET_HOSTS` and `ALLOWED_TARGET_PORTS` from its environment as the worker
does. `ALLOW_PRIVATE_TARGETS` is ignored when the flag is passed.

### What the guard does not cover

- It judges addresses, not intent. A public address of your own infrastructure (for example
  the worker host's public IP) is allowed on ports 80 and 443. Keep firewall rules that stop
  workers reaching your own services.
- Only HTTP, HTTPS and WebSocket traffic goes through the proxy. Chromium's WebRTC (UDP)
  traffic does not.
- Monitors created before the guard existed are not rechecked by the API, but the worker
  refuses them at use time.
- A refusal still shows that a name resolves to a private or internal address, and a name
  that does not resolve is reported differently. Someone who can create monitors can therefore
  test whether a name exists in your internal DNS, though not where it points.
