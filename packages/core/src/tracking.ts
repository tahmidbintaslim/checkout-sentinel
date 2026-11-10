import { z } from 'zod';

/**
 * Marketing and analytics tags the journey can see firing. A tag "fires" when the browser
 * sends a request to one of its collection or loader endpoints. Matching is on host and
 * path only; query strings (event names, pixel IDs) are not read.
 *
 * The journey never places an order, so purchase events never fire. What this proves is
 * that each tag still loads and sends on product, cart and checkout pages: the usual way a
 * theme edit, app update or consent change breaks tracking.
 */
export const TAG_IDS = [
  'ga4',
  'gtm',
  'google_ads',
  'meta',
  'tiktok',
  'pinterest',
  'klaviyo',
] as const;
export const TagIdSchema = z.enum(TAG_IDS);
export type TagId = z.infer<typeof TagIdSchema>;

export const TAG_LABELS: Record<TagId, string> = {
  ga4: 'Google Analytics 4',
  gtm: 'Google Tag Manager',
  google_ads: 'Google Ads',
  meta: 'Meta Pixel',
  tiktok: 'TikTok Pixel',
  pinterest: 'Pinterest Tag',
  klaviyo: 'Klaviyo',
};

type Matcher = (host: string, path: string) => boolean;

const endsWith = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

const MATCHERS: Record<TagId, Matcher> = {
  // gtag.js loader, or a hit to the GA4 collect endpoint (regional hosts included).
  ga4: (host, path) =>
    (endsWith(host, 'google-analytics.com') && /\/g\/collect$/.test(path)) ||
    (host === 'www.googletagmanager.com' && path === '/gtag/js'),
  gtm: (host, path) => host === 'www.googletagmanager.com' && path === '/gtm.js',
  google_ads: (host, path) =>
    (host === 'googleads.g.doubleclick.net' && path.startsWith('/pagead/')) ||
    (host === 'www.googleadservices.com' && path.startsWith('/pagead/')),
  meta: (host, path) =>
    (endsWith(host, 'facebook.com') && path === '/tr') ||
    (endsWith(host, 'facebook.com') && path.startsWith('/tr/')) ||
    (host === 'connect.facebook.net' && path.endsWith('/fbevents.js')),
  tiktok: (host) => host === 'analytics.tiktok.com',
  pinterest: (host, path) =>
    host === 'ct.pinterest.com' || (host === 's.pinimg.com' && path.startsWith('/ct/')),
  klaviyo: (host) => host === 'static.klaviyo.com' || host === 'static-tracking.klaviyo.com',
};

/** The tags a request URL belongs to; empty for anything else or an unparseable URL. */
export function tagsForUrl(input: string): TagId[] {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  return TAG_IDS.filter((id) => MATCHERS[id](host, url.pathname));
}

/** Expected tags that did not fire on any step of a journey, in TAG_IDS order. */
export function missingTags(expected: readonly TagId[], seen: Iterable<string>): TagId[] {
  const fired = new Set(seen);
  return TAG_IDS.filter((id) => expected.includes(id) && !fired.has(id));
}
