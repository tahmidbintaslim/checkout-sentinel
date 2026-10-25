import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface WebhookReceiver {
  url: (path: string) => string;
  received: ReceivedWebhook[];
  waitFor: (count: number, timeoutMs?: number) => Promise<ReceivedWebhook[]>;
  close: () => Promise<void>;
}

/** Local HTTP endpoint that records POSTed JSON, standing in for Slack and webhooks in tests. */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      received.push({ path: req.url ?? '/', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    received,
    waitFor: async (count, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return received;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
