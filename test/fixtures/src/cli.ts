import { startFixtureStore, type FixturePlatform, type FixtureVariant } from './index.js';

/** Starts every fixture store on consecutive ports, for trying the CLI locally. */
const basePort = Number(process.env.FIXTURE_BASE_PORT ?? 4010);
const combos: Array<[FixturePlatform, FixtureVariant]> = [
  ['shopify', 'ok'],
  ['shopify', 'mobile-hidden'],
  ['shopify', 'js-error'],
  ['shopify', 'cart-500'],
  ['shopify', 'checkout-404'],
  ['woocommerce', 'ok'],
  ['woocommerce', 'mobile-hidden'],
  ['woocommerce', 'js-error'],
  ['woocommerce', 'cart-500'],
  ['woocommerce', 'checkout-404'],
];

const stores = await Promise.all(
  combos.map(([platform, variant], index) =>
    startFixtureStore({ platform, variant, port: basePort + index }),
  ),
);
for (const store of stores) {
  console.log(`${`${store.platform}/${store.variant}`.padEnd(26)} ${store.productUrl}`);
}
console.log('Fixture stores running. Press Ctrl+C to stop.');

const shutdown = () => {
  void Promise.all(stores.map((store) => store.close())).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
