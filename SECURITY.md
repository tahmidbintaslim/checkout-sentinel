# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub security advisories](https://github.com/tahmidbintaslim/checkout-sentinel/security/advisories/new)
rather than a public issue. Include steps to reproduce and the version or commit. You should get
an acknowledgement within a few days. This is a small open-source project with no bug bounty.

## Supported versions

Only the latest release receives fixes while the project is in 0.x.

## Things to know when self-hosting

- **Set `API_TOKEN`.** Without it the API accepts unauthenticated requests. `/health`,
  `/metrics` and `/docs` are always public; do not expose the API to the internet without a token
  and TLS in front of it.
- **Monitor and webhook URLs are fetched by your servers.** Anyone who can create a monitor can
  make the worker's browser load any URL its network can reach, including internal services
  (server-side request forgery). v0.1 only checks that URLs are http or https. Run workers in a
  network segment that cannot reach internal systems, and do not let untrusted users create
  monitors.
- **Webhook URLs are credentials.** Slack webhook URLs are masked in API responses and webhook
  secrets are never returned, but both are stored in plain text in Postgres. Protect database
  access and backups accordingly.
- **Verify webhook signatures.** If you set a `secret` on a webhook channel, check the
  `x-checkout-sentinel-signature` header (`sha256=` HMAC of the raw body) before trusting a
  delivery.
- **Artifacts may contain store content.** Failure screenshots and traces capture the pages the
  journey visited, including cookies in traces. Treat the artifacts volume as sensitive.
- **The journey never pays.** It does not fill or submit checkout forms, and order placement and
  payment requests are blocked in the browser. If you find a way it could place an order, please
  report it as a security issue.
