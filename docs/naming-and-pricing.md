# Naming and pricing: proposal

Status: draft for the owner to decide, November 2026. Nothing here is registered or live.

## Name shortlist

The name should say "your store keeps selling" (checkout, tracking and what changed, on Shopify
and WooCommerce), not only "cart". Domains were checked with a registry lookup on 2026-11-20;
availability is not a hold. The search was a web search for existing products, **not a
trademark search**: run one (USPTO, EUIPO, and the Shopify App Store and WordPress.org
directories) before registering anything.

| Name                          | Domains available                       | Existing products found | Notes                                                                                          |
| ----------------------------- | --------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| **StoreIntact** (recommended) | storeintact.com, storeintact.io         | None                    | Says the outcome ("your store stays intact"); platform-neutral; the .com is free               |
| SalesIntact                   | salesintact.com                         | Not searched            | Same idea, focused on sales; weaker as a product name                                          |
| Tillwatch                     | tillwatch.io, tillwatch.co (.com taken) | None                    | Short; "till" reads as British for checkout, less clear in the US                              |
| SalesVigil                    | .com, .io, .app, .co                    | None by that name       | **Risky:** "StoreVigil" is a competing storefront monitor (Shopify and Wix, launched Oct 2026) |
| CheckoutPatrol                | checkoutpatrol.com, .io                 | Not searched            | Clear, but says "checkout only", which the product has outgrown                                |

Ruled out: StoreVigil (an existing competitor), and every short .com tried before (cartwatch,
cartping, checkoutwatch, storewatch and others are taken).

## Pricing

### Competitors (from their listings, Nov 2026; not verified)

| Product                   | Price                                    |
| ------------------------- | ---------------------------------------- |
| Revenue Shield (Shopify)  | Free plan; $39 and $79 per month         |
| CheckoutGuard (Shopify)   | From $29 per month                       |
| StoreVigil (Shopify, Wix) | Free up to 3 pages; $36 to $45 per month |
| AppPulse (Shopify)        | $5.99 per month                          |

### Proposal

Priced per store and check frequency, the two things that drive cost (each check is a real
browser on two devices). Same prices on the web (Stripe) and in the Shopify App Store (Shopify
Billing).

| Plan    | Price / month | Stores | Product URLs | Checks every | History | Includes                                  |
| ------- | ------------- | ------ | ------------ | ------------ | ------- | ----------------------------------------- |
| Free    | $0            | 1      | 1            | 60 min       | 7 days  | Checkout checks, email and Slack alerts   |
| Starter | $29           | 1      | 3            | 15 min       | 30 days | + Tracking checks, what changed, webhooks |
| Growth  | $79           | 5      | 15           | 5 min        | 90 days | + Priority alerts, API keys               |
| Agency  | $199          | 25     | 75           | 5 min        | 90 days | + Team workspaces, client reports (later) |

Yearly: two months free. 14-day trial of Growth, no card on the web.

### Capacity check

A journey takes roughly 20 to 40 seconds per device, so one product URL checked every 15
minutes on desktop and mobile uses about 1.5 hours of browser time a day. A 2 vCPU server
running two journeys at once covers about 30 such URLs. At 5-minute checks a URL costs three
times that, so Growth and Agency need more workers per customer, which their prices allow. These
figures are estimates; measure real journey times before fixing the limits.

## Decisions needed

1. The name (and a trademark search before buying the domain).
2. The plan limits and prices above, or changes to them.
