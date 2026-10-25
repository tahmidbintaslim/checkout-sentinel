import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request, type Response } from 'express';

/**
 * Minimal stand-ins for a Shopify Online Store 2.0 theme and a WooCommerce single product
 * template. They copy only the markup, endpoints and redirects checkout-sentinel relies on,
 * so tests exercise the engine without touching a real store.
 */
export type FixturePlatform = 'shopify' | 'woocommerce' | 'generic';

export type FixtureVariant =
  /** Everything works. */
  | 'ok'
  /** Theme CSS hides the add-to-cart button below 750px. */
  | 'mobile-hidden'
  /** A script throws on load. Shopify: the AJAX add-to-cart handler never binds. WooCommerce: the form still works. */
  | 'js-error'
  /** The cart add endpoint answers 500. */
  | 'cart-500'
  /** The checkout route answers 404. */
  | 'checkout-404'
  /**
   * The product page, requested by any host name other than 127.0.0.1, redirects to the same
   * page on http://127.0.0.1, the way a hostile store could steer the browser to an internal
   * address. SSRF guard tests.
   */
  | 'redirect-to-loopback';

export interface FixtureStoreOptions {
  platform: FixturePlatform;
  variant?: FixtureVariant;
  port?: number;
  host?: string;
  /** Delay before the checkout responds, for slow-step tests. */
  checkoutDelayMs?: number;
}

export interface FixtureStore {
  origin: string;
  productUrl: string;
  platform: FixturePlatform;
  variant: FixtureVariant;
  /** Number of order placement attempts received. Tests assert this stays 0. */
  orderAttempts(): number;
  /** Distinct User-Agent headers seen by the store. */
  userAgents(): string[];
  close(): Promise<void>;
}

const SESSION_COOKIE = 'fixture_session';

function page(title: string, head: string, body: string, bodyClass = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const PRODUCT_PATHS: Readonly<Record<FixturePlatform, string>> = {
  shopify: '/products/demo-tee',
  woocommerce: '/product/demo-hoodie/',
  generic: '/shop/widget',
};

export function createFixtureApp(options: FixtureStoreOptions): {
  app: express.Express;
  orderAttempts: () => number;
  userAgents: () => string[];
} {
  const variant = options.variant ?? 'ok';
  const carts = new Map<string, number>();
  let orders = 0;
  const app = express();
  const agents = new Set<string>();
  app.disable('x-powered-by');
  app.use((req, _res, next) => {
    if (req.headers['user-agent']) agents.add(req.headers['user-agent']);
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  if (variant === 'redirect-to-loopback') {
    const productPath = PRODUCT_PATHS[options.platform];
    app.use((req, res, next) => {
      if (req.method === 'GET' && req.path === productPath && req.hostname !== '127.0.0.1') {
        res.redirect(302, `http://127.0.0.1:${req.socket.localPort}${req.originalUrl}`);
        return;
      }
      next();
    });
  }

  const session = (req: Request, res: Response): string => {
    const cookie = req.headers.cookie ?? '';
    const match = new RegExp(`${SESSION_COOKIE}=([\\w-]+)`).exec(cookie);
    if (match?.[1]) return match[1];
    const id = randomUUID();
    res.cookie(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/' });
    return id;
  };
  const cartCount = (req: Request, res: Response) => carts.get(session(req, res)) ?? 0;
  const addItem = (req: Request, res: Response, quantity = 1) => {
    const id = session(req, res);
    carts.set(id, (carts.get(id) ?? 0) + quantity);
  };

  const hideOnMobile =
    variant === 'mobile-hidden'
      ? '<style>@media screen and (max-width: 749px) { .product-form__submit, .single_add_to_cart_button { display: none !important; } }</style>'
      : '';
  const brokenScript =
    variant === 'js-error' ? '<script>window.reviewsWidget.init({ stars: 5 });</script>' : '';

  if (options.platform === 'shopify') {
    app.use((_req, res, next) => {
      res.setHeader('x-shopid', '0000000');
      res.setHeader('powered-by', 'Shopify');
      next();
    });

    app.get('/products/demo-tee', (req, res) => {
      session(req, res);
      // In the js-error variant the button is driven by theme JS (common for AJAX drawers),
      // and an app script that throws first stops the handler from ever binding.
      const button =
        variant === 'js-error'
          ? '<button type="button" name="add" class="product-form__submit" id="ajax-add">Add to cart</button>'
          : '<button type="submit" name="add" class="product-form__submit">Add to cart</button>';
      const ajaxScript =
        variant === 'js-error'
          ? `<script>
// An app snippet that runs before the theme handler. It throws, so the handler below never binds.
window.reviewsWidget.init({ stars: 5 });
document.getElementById('ajax-add').addEventListener('click', async () => {
  await fetch('/cart/add.js', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 4242, quantity: 1 }) });
});
</script>`
          : '';
      res.type('html').send(
        page(
          'Demo Tee - Fixture Shopify Store',
          `<meta name="shopify-checkout-api-token" content="fixture-token">
<script>window.Shopify = { shop: 'fixture-store.myshopify.com', theme: { name: 'Dawn' } };</script>
${hideOnMobile}`,
          `<main>
<h1>Demo Tee</h1>
<p>$25.00</p>
<form method="post" action="/cart/add" id="product-form" class="form">
  <input type="hidden" name="id" value="4242">
  <input type="number" name="quantity" value="1" min="1">
  ${button}
</form>
</main>
${ajaxScript}`,
        ),
      );
    });

    app.post('/cart/add', (req, res) => {
      if (variant === 'cart-500') {
        res
          .status(500)
          .type('html')
          .send(page('Error', '', '<h1>Internal Server Error</h1>'));
        return;
      }
      addItem(req, res, Number(req.body?.quantity ?? 1) || 1);
      res.redirect(302, '/cart');
    });

    app.post('/cart/add.js', (req, res) => {
      if (variant === 'cart-500') {
        res.status(500).json({ status: 500, message: 'Cart Error' });
        return;
      }
      addItem(req, res, Number(req.body?.quantity ?? 1) || 1);
      res.json({ id: 4242, quantity: 1 });
    });

    app.get('/cart.js', (req, res) => {
      const count = cartCount(req, res);
      res.json({ token: 'fixture', item_count: count, items: [] });
    });

    app.get('/cart', (req, res) => {
      const count = cartCount(req, res);
      res
        .type('html')
        .send(
          page(
            'Cart',
            '<script>window.Shopify = {};</script>',
            `<h1>Your cart</h1><p>${count} item(s)</p><a href="/checkout" name="checkout">Check out</a>`,
          ),
        );
    });

    app.get('/checkout', (req, res) => {
      if (variant === 'checkout-404') {
        res
          .status(404)
          .type('html')
          .send(page('Not found', '', '<h1>404 Page not found</h1>'));
        return;
      }
      if (cartCount(req, res) === 0) {
        res.redirect(302, '/cart');
        return;
      }
      res.redirect(302, '/checkouts/cn/fixture-checkout-xyz');
    });

    app.get('/checkouts/cn/:token', async (req, res) => {
      if (options.checkoutDelayMs) await sleep(options.checkoutDelayMs);
      res.type('html').send(
        page(
          'Checkout - Fixture Shopify Store',
          '',
          `<div data-checkout-root>
<h1>Contact</h1>
<form action="/checkouts/cn/${req.params.token}/processing" method="post">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" autocomplete="email">
  <button type="submit">Pay now</button>
</form>
</div>`,
        ),
      );
    });

    app.post('/checkouts/cn/:token/processing', (_req, res) => {
      orders += 1;
      res.status(200).send('order placed');
    });
  }

  if (options.platform === 'woocommerce') {
    const productPath = '/product/demo-hoodie/';
    const wooHead = `<meta name="generator" content="WooCommerce 9.4.2">
<script>var wc_add_to_cart_params = { ajax_url: '/wp-admin/admin-ajax.php', wc_ajax_url: '/?wc-ajax=%%endpoint%%' };</script>
${hideOnMobile}
${brokenScript}`;
    const productPage = (notice: string) =>
      page(
        'Demo Hoodie - Fixture WooCommerce Store',
        wooHead,
        `<main>
${notice}
<h1 class="product_title entry-title">Demo Hoodie</h1>
<p class="price">$45.00</p>
<form class="cart" action="${productPath}" method="post" enctype="application/x-www-form-urlencoded">
  <div class="quantity"><input type="number" name="quantity" value="1" min="1"></div>
  <button type="submit" name="add-to-cart" value="42" class="single_add_to_cart_button button alt">Add to cart</button>
</form>
</main>`,
        'product-template-default single single-product woocommerce woocommerce-page',
      );

    app.get(productPath, (req, res) => {
      session(req, res);
      res.type('html').send(productPage(''));
    });

    app.post(productPath, (req, res) => {
      if (variant === 'cart-500') {
        res
          .status(500)
          .type('html')
          .send(page('Error', '', '<h1>There has been a critical error on this website.</h1>'));
        return;
      }
      addItem(req, res, Number(req.body?.quantity ?? 1) || 1);
      res
        .type('html')
        .send(
          productPage(
            '<div class="woocommerce-message" role="alert">"Demo Hoodie" has been added to your cart.</div>',
          ),
        );
    });

    app.get('/wp-json/wc/store/v1/cart', (req, res) => {
      res.json({ items_count: cartCount(req, res), items: [] });
    });

    app.get('/cart/', (req, res) => {
      const count = cartCount(req, res);
      const body =
        count === 0
          ? '<p class="cart-empty woocommerce-info">Your cart is currently empty.</p>'
          : `<form class="woocommerce-cart-form"><table><tr class="woocommerce-cart-form__cart-item cart_item"><td>Demo Hoodie x ${count}</td></tr></table></form>
<a href="/checkout/" class="checkout-button button alt wc-forward">Proceed to checkout</a>`;
      res.type('html').send(page('Cart', wooHead, body, 'woocommerce-cart woocommerce-page'));
    });

    app.get('/checkout/', async (req, res) => {
      if (variant === 'checkout-404') {
        res
          .status(404)
          .type('html')
          .send(page('Page not found', '', '<h1>Oops! That page can’t be found.</h1>'));
        return;
      }
      if (cartCount(req, res) === 0) {
        res.redirect(302, '/cart/');
        return;
      }
      if (options.checkoutDelayMs) await sleep(options.checkoutDelayMs);
      res.type('html').send(
        page(
          'Checkout',
          wooHead,
          `<form name="checkout" method="post" class="checkout woocommerce-checkout" action="/checkout/">
  <label for="billing_email">Email address</label>
  <input type="email" class="input-text" name="billing_email" id="billing_email" autocomplete="email">
  <button type="submit" id="place_order">Place order</button>
</form>`,
          'woocommerce-checkout woocommerce-page',
        ),
      );
    });

    app.post('/checkout/', (_req, res) => {
      orders += 1;
      res.status(200).send('order placed');
    });
    app.post('/', (req, res) => {
      if (req.query['wc-ajax'] === 'checkout') orders += 1;
      res.status(200).json({ result: 'success' });
    });
  }

  if (options.platform === 'generic') {
    app.get('/shop/widget', (req, res) => {
      session(req, res);
      res.type('html').send(
        page(
          'Widget',
          hideOnMobile,
          `<main><h1>Widget</h1>
<button type="button" class="product-form__submit" onclick="document.getElementById('msg').textContent='Added'">Add to bag</button>
<p id="msg"></p></main>`,
        ),
      );
    });
    app.get('/checkout', (_req, res) => {
      res
        .type('html')
        .send(
          page('Checkout', '', '<form class="checkout"><input type="email" name="email"></form>'),
        );
    });
  }

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  return { app, orderAttempts: () => orders, userAgents: () => [...agents] };
}

export async function startFixtureStore(options: FixtureStoreOptions): Promise<FixtureStore> {
  const { app, orderAttempts, userAgents } = createFixtureApp(options);
  const host = options.host ?? '127.0.0.1';
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(options.port ?? 0, host, (error?: Error) => {
      if (error) reject(error);
      else resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host}:${port}`;
  return {
    origin,
    productUrl: `${origin}${PRODUCT_PATHS[options.platform]}`,
    platform: options.platform,
    variant: options.variant ?? 'ok',
    orderAttempts,
    userAgents,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export { probeTestServices, truncateAll, TEST_DATABASE_URL, TEST_REDIS_URL } from './services.js';
export type { ServiceAvailability } from './services.js';
export { startWebhookReceiver, type WebhookReceiver } from './webhook-receiver.js';
