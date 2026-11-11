import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

/** The apps/web build in this repository; src/ and dist/ sit at the same depth. */
export const DEFAULT_DASHBOARD_DIR = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** The prefix every API route is also served under. The dashboard calls the API there. */
export const API_PREFIX = '/api';

/**
 * First path segments that always belong to the API, never to the dashboard, whatever the
 * Accept header says: the API prefix, Swagger UI and the two scrape endpoints.
 */
const API_ONLY_SEGMENTS = new Set(['api', 'docs', 'health', 'metrics']);

/**
 * Pages are fetched by the dashboard's own scripts only. Images come from blob: URLs, because
 * artifacts are fetched with the bearer token. The only outside origin is Cloudflare Turnstile,
 * which the public scanner page loads.
 */
export const DASHBOARD_CSP = dashboardCsp();

/**
 * The Frontend API host a Clerk publishable key names: the key is "pk_test_" or "pk_live_"
 * followed by base64 of "<host>$". Null when the key does not decode to a host name.
 */
export function clerkFrontendHost(publishableKey: string): string | null {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
}

/**
 * With a Clerk host, the policy also allows what Clerk's sign-in components need (its docs,
 * "CSP headers"): scripts and requests to that host, its image host, blob workers, and inline
 * styles, which Clerk injects at runtime.
 */
export function dashboardCsp(clerkHost?: string): string {
  const clerk = clerkHost ? ` https://${clerkHost}` : '';
  return [
    "default-src 'self'",
    // Cloudflare Turnstile, for the public scanner page (and Clerk's bot protection).
    `script-src 'self' https://challenges.cloudflare.com${clerk}`,
    'frame-src https://challenges.cloudflare.com',
    clerkHost ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    `img-src 'self' blob: data:${clerkHost ? ' https://img.clerk.com' : ''}`,
    `connect-src 'self'${clerk}`,
    ...(clerkHost ? ["worker-src 'self' blob:"] : []),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const BASE_PAGE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // index.html names the hashed asset files of the current build; always revalidate it.
  'cache-control': 'no-cache',
};

/**
 * Serves /api/... as /...: the v0.1 paths stay as they are and the same routes answer under
 * /api, so OpenAPI paths, metrics route labels and existing clients do not change.
 */
export function apiPrefixAlias(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const url = req.url;
    if (
      url === API_PREFIX ||
      url.startsWith(`${API_PREFIX}/`) ||
      url.startsWith(`${API_PREFIX}?`)
    ) {
      const rest = url.slice(API_PREFIX.length);
      req.url = rest.startsWith('/') ? rest : `/${rest}`;
    }
    next();
  };
}

export function hasDashboardBuild(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html'));
}

/**
 * Serves the built dashboard. Files of the build (index.html, hashed assets) are served as
 * they are. Any other GET is the dashboard's index.html when the client prefers HTML over JSON,
 * which a browser loading a page does and API clients (fetch, curl, SDKs) do not; so
 * /monitors/<id> opened in a browser shows the dashboard page, while the same request from a
 * script still reaches the API. Must run before apiPrefixAlias, which rewrites the path.
 */
export function dashboardHandler(dir: string, csp = DASHBOARD_CSP): RequestHandler {
  const PAGE_HEADERS = { ...BASE_PAGE_HEADERS, 'content-security-policy': csp };
  const root = path.resolve(dir);
  const indexFile = path.join(root, 'index.html');
  const files = express.static(root, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      res.setHeader('x-content-type-options', 'nosniff');
      if (file === indexFile) {
        for (const [name, value] of Object.entries(PAGE_HEADERS)) res.setHeader(name, value);
      } else if (path.relative(root, file).startsWith(`assets${path.sep}`)) {
        // Vite puts a content hash in every file name under assets/.
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('cache-control', 'public, max-age=3600');
      }
    },
  });

  const sendIndex = (res: Response, next: NextFunction) => {
    res.sendFile(indexFile, { headers: PAGE_HEADERS, dotfiles: 'deny' }, (error?: Error) => {
      if (error && !res.headersSent) next(error);
    });
  };

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const segment = req.path.split('/')[1] ?? '';
    if (API_ONLY_SEGMENTS.has(segment)) return next();
    files(req, res, () => {
      // Nothing of the API lives at /, so it is the dashboard for every client.
      if (req.path === '/' || req.accepts(['json', 'html']) === 'html') return sendIndex(res, next);
      next();
    });
  };
}
