=== Checkout Sentinel ===
Contributors: checkoutsentinel
Tags: woocommerce, monitoring, checkout, alerts, changelog
Requires at least: 6.4
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT

Tells Checkout Sentinel what changed on your store, so a broken-checkout alert names the plugin, theme or WordPress update that came just before it.

== Description ==

Checkout Sentinel runs a real browser through your product page, cart and checkout on a schedule and alerts you when a step breaks or a tracking tag stops firing. Most breakage follows a change. This plugin reports those changes:

* plugins installed, updated, activated or deactivated,
* themes installed, updated or switched,
* WordPress updates.

When a check fails, the alert lists the changes from the 24 hours before it.

= What is sent =

Only the name and version of what changed, the time, and your site address, to the API address you enter. Nothing about customers, orders or payments. Nothing at all until you save an API key.

== Installation ==

1. Install and activate the plugin.
2. In the Checkout Sentinel dashboard, open API keys and create a key.
3. In WordPress, open Settings > Checkout Sentinel, enter the API address and the key, save, and click Test connection.

== Changelog ==

= 0.1.0 =
* First release: reports plugin, theme and WordPress changes.
