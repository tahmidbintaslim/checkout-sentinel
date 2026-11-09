# Launch plan: hosted SaaS on web, Shopify and WordPress

Status: draft, November 2026. The product name is still open (see [Naming](#naming)).

## Positioning

Checkout-only synthetic monitors are already a crowded category in 2026 (Shopify: Revenue
Shield, Revenue Guard, CheckoutGuard, AppPulse, BestGuard; WooCommerce: Cart Lookout, Checkout
Pilot, CheckoutAlert, Checkout Watch, CheckView, MageSentinel; generic: Checkly, Pingdom). We do
not launch as one more of them. We cover the store's whole **revenue path**, in three parts that
no competitor we found offers together:

1. **Checkout works.** The existing journey: product, add to cart, cart, checkout, on desktop
   and mobile, Shopify and WooCommerce, never placing an order.
2. **Tracking works.** Meta Pixel, GA4 and other tags still fire on product, cart and checkout.
   Silent pixel breakage after theme or plugin updates is common and expensive (ads optimise on
   bad data). Shipped in the first PR.
3. **What changed.** When a check breaks, the alert names the likely cause: the app, plugin or
   theme change that landed just before it. Change-log apps record changes and checkout monitors
   detect breakage; nobody joins the two.

Primary buyer: agencies and multi-store brands running both Shopify and WooCommerce. Entry plan:
single-store merchants, through the Shopify App Store and WordPress.org.

## Staged pull requests

| #   | Scope                                                                                                                                   | Notes                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Tracking checks in the engine, CLI, worker alerts and dashboard                                                                         | Done in this branch                                        |
| 2   | Multi-tenant core: workspaces, Clerk sign-in, per-workspace API keys, every query scoped by workspace                                   | Replaces the single admin token; self-hosted mode keeps it |
| 3   | Billing: Stripe plans by store count and check frequency, plan limits enforced in the API                                               | Web and WordPress customers                                |
| 4   | "What changed": change-event ingest endpoint, timeline per store, cause hint in alerts                                                  | Fed by the Shopify app and WordPress plugin                |
| 5   | Shopify app: OAuth install, Shopify Billing, store and product picked from the Admin API, theme and app webhooks to the change timeline | Shopify requires its own billing for App Store apps        |
| 6   | WordPress plugin: connects a WooCommerce store to a workspace, reports plugin, theme and core updates                                   | Thin client; checks run on our side                        |
| 7   | Brand, marketing site, pricing and comparison pages                                                                                     | After the name is chosen                                   |

Later: auto-baseline for tracking (alert when a tag that used to fire disappears, with no
configuration), client-facing reports for agencies, more channels (email, Teams).

## Naming

The name should point at protecting sales across the whole revenue path, not just "cart". Every
short bare .com we checked (cartwatch, cartping, checkoutwatch and others) is taken. Shortlist
and a trademark search come before PR 7.
