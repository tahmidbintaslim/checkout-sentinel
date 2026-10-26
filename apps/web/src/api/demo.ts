/**
 * The read-only demo build (vite build --mode demo) answers the API client's requests from static JSON
 * written by scripts/demo-data.ts, served under <base>demo-data/. Every write answers 403, so
 * the dashboard shows its usual error notice instead of pretending a change was saved.
 */

export const READ_ONLY_MESSAGE =
  'This is a read-only demo with sample data. Run checkout-sentinel yourself to create or change monitors.';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Maps an API path (without the /api prefix) to the demo file that holds its answer. */
export function demoFileFor(apiPath: string): string | null {
  const route: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/^\/monitors$/, () => 'monitors.json'],
    [/^\/monitors\/([^/]+)$/, (m) => `monitors/${m[1]}.json`],
    [/^\/monitors\/([^/]+)\/runs$/, (m) => `monitor-runs/${m[1]}.json`],
    [/^\/runs\/([^/]+)$/, (m) => `runs/${m[1]}.json`],
    [/^\/runs\/([^/]+)\/artifacts\/([^/]+)$/, (m) => `artifacts/${m[1]}/${m[2]}`],
    [/^\/alerts$/, () => 'alerts.json'],
  ];
  for (const [pattern, file] of route) {
    const match = apiPath.match(pattern);
    // The segments come from encodeURIComponent in the client; refuse anything that could
    // climb out of the data directory.
    if (match && match.slice(1).every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith('.'))) {
      return file(match);
    }
  }
  return null;
}

interface PageBody {
  items: Array<{ monitorId?: string }>;
  nextCursor: string | null;
}

export function createDemoFetch(
  dataBase: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return json({ message: READ_ONLY_MESSAGE }, 403);

    const url = new URL(String(input), 'http://demo.invalid');
    const apiPath = url.pathname.replace(/^\/api/, '');
    const file = demoFileFor(apiPath);
    if (!file) return json({ message: 'Not found in the demo data' }, 404);

    const response = await fetchImpl(`${dataBase}${file}`);
    // A static host with an app fallback answers a missing file with index.html and 200.
    const html = (response.headers.get('content-type') ?? '').includes('text/html');
    if (!response.ok || html) return json({ message: 'Not found in the demo data' }, 404);

    // The alert log filters by monitor; the demo holds one page per list, so no cursor.
    const monitorId = url.searchParams.get('monitorId');
    if (apiPath === '/alerts' && monitorId) {
      const page = (await response.json()) as PageBody;
      return json({ ...page, items: page.items.filter((a) => a.monitorId === monitorId) });
    }
    return response;
  };
}
