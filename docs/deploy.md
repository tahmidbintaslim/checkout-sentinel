# Deploying the hosted product

The simplest deployment that runs every feature is **one Linux server running the Docker
Compose stack** (Postgres, Redis, API with the dashboard, worker) with Caddy in front for
HTTPS. It needs no code changes.

Why one server: the worker writes failure screenshots and traces to disk and the API serves
them from the same directory (`ARTIFACTS_DIR`, a shared volume). Platforms that give each
service its own disk, as many PaaS hosts do, would lose screenshots in the dashboard until
artifacts move to object storage (S3 or R2).

## Server

- 2 vCPU and 4 GB RAM to start: each journey runs Chromium. Add RAM before raising
  `WORKER_CONCURRENCY`.
- Docker Engine with the Compose plugin.
- A DNS A (and AAAA) record for the public host, for example `app.example.com`, pointing at the
  server, and ports 80 and 443 open. Caddy needs both to get the certificate.

## First start

```bash
git clone https://github.com/tahmidbintaslim/checkout-sentinel.git && cd checkout-sentinel
cp .env.example .env
```

In `.env`, set at least:

| Variable                 | Value                                                   |
| ------------------------ | ------------------------------------------------------- |
| `DOMAIN`                 | The public host, for example `app.example.com`          |
| `POSTGRES_PASSWORD`      | A long random password                                  |
| `API_TOKEN`              | A long random token (until Clerk is set up)             |
| `PUBLIC_BASE_URL`        | `https://<DOMAIN>`: alert links point here              |
| `USER_AGENT_CONTACT_URL` | A page about the product, shown to the stores you check |

Then:

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

Check `https://<DOMAIN>/health` answers `{"status":"ok",...}`, then open `https://<DOMAIN>/`.

## Turning on hosted features

Each is optional; set the variables in `.env` and run the `up -d` command again.

- **Accounts (Clerk):** `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, and
  `CLERK_AUTHORIZED_PARTIES=https://<DOMAIN>`. Add `https://<DOMAIN>` to the Clerk application's
  allowed origins.
- **Public scanner:** `SCANNER_ENABLED=true`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
  (a Turnstile widget for `<DOMAIN>`). The overlay already sets `TRUST_PROXY_HOPS=1` for Caddy.
- **Shopify webhooks:** `SHOPIFY_API_SECRET`; the app's webhook URL is
  `https://<DOMAIN>/api/webhooks/shopify`.
- **WordPress plugin:** in WordPress, Settings > Checkout Sentinel: API address
  `https://<DOMAIN>` and an API key from the dashboard.

## Updating

```bash
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

The API applies database migrations when it starts; the worker waits for it.

## Backups

Postgres holds monitors, run history, accounts and keys. A nightly dump, for example in the
server's crontab:

```bash
0 3 * * * cd /root/checkout-sentinel && docker compose exec -T postgres pg_dump -U sentinel checkout_sentinel | gzip > /root/backups/db-$(date +\%F).sql.gz
```

Copy the dumps off the server. Redis holds only the queue and is rebuilt from Postgres on start.
