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

## Why synthetic checks stay the core

An alternative plan (a Shopify-only real-user monitoring app: an in-page script reporting
JavaScript errors, failed cart calls and Core Web Vitals) was weighed and folded in, not
adopted wholesale. Scheduled browser checks find breakage with zero traffic, at 3 a.m., on
Shopify and WooCommerce alike; in-page monitoring only reports once real shoppers hit the
problem. The two complement each other, so the Shopify app and WordPress plugin add real-user
sensors on top of the synthetic core.

Platform facts this plan relies on (checked November 2026): Shopify blocks creating storefront
script tags from 1 October 2026 and stops running them on 1 March 2027, so in-page code ships
as a theme app embed or web pixel. App Store apps must bill through Shopify. Shopify takes 0%
of the first USD 1M of lifetime app revenue, 15% above that. A monitoring app gets read-only
theme access.

## Order of work

| #   | Scope                                                                                                                                                                     | Notes                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0   | Interview 10-20 merchants and agencies: how they find broken checkouts, pixels and app conflicts today, and what they would pay                                           | Before building billing; decides pricing and the lead buyer |
| 1   | Tracking checks in the engine, CLI, worker alerts and dashboard                                                                                                           | Done in this branch                                         |
| 2   | Free public scanner: paste a store URL, get one journey with tag checks as a report                                                                                       | Done in this branch                                         |
| 3   | Multi-tenant core: workspaces, Clerk sign-in, per-workspace API keys, every query scoped by workspace                                                                     | Done                                                        |
| 4   | Shopify app: embedded Polaris shell on our API, web pixel (real add-to-cart and purchase events), theme app embed (JS errors, failed cart calls), `themes/update` webhook | Read-only scopes; GDPR webhooks; zero PII                   |
| 5   | "What changed": change-event timeline per store, leftover-snippet scan of theme files, cause hint in alerts                                                               | Fed by the Shopify app and WordPress plugin                 |
| 6   | WordPress plugin: connects a WooCommerce store, reports plugin, theme and core updates, ships the same in-page sensor                                                     | Thin client; checks run on our side                         |
| 7   | Billing: Shopify Billing for App Store installs, Stripe for web and WordPress; plans by store count and check frequency                                                   |                                                             |
| 8   | Brand, marketing site, pricing and comparison pages                                                                                                                       | After the name is chosen                                    |

Later, only when paying customers ask: Core Web Vitals by template, rage and dead clicks,
session replay, AI fix suggestions, Hydrogen and headless support, auto-baseline for tracking,
agency client reports, more alert channels.

## Naming

The name should point at protecting sales across the whole revenue path, not just "cart". Every
short bare .com we checked (cartwatch, cartping, checkoutwatch and others) is taken. Shortlist
and a trademark search come before step 8.
