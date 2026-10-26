import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { pipeline, type Duplex } from 'node:stream';
import { TargetBlockedError, normalizeHost, type TargetGuard } from './ssrf.js';

/**
 * A forward proxy for one journey's browser context. Playwright's route handlers do not see
 * redirect hops (Chromium follows them internally), so routing alone cannot stop a store
 * redirecting the browser to an internal host. With the context's traffic sent through this
 * proxy, every connection the browser or the context's request client opens (navigations,
 * redirect hops, frames, subresources, cart API reads) is checked against the guard, and the
 * socket connects to the address that was checked, never to a second DNS answer.
 *
 * HTTPS goes through CONNECT tunnels, so TLS stays end to end between Chromium and the store.
 * The proxy listens on 127.0.0.1 only and can itself reach only addresses the guard allows.
 */

export interface EgressEvent {
  at: string;
  /** host:port the browser asked for. */
  target: string;
  host: string;
  /** blocked: refused by the guard. failed: allowed, but DNS or the connection failed. */
  outcome: 'blocked' | 'failed';
  reason: string;
}

export interface EgressProxyOptions {
  /** How long to wait for an upstream connection. */
  connectTimeoutMs: number;
}

/** Response header marking proxy-generated answers (blocked or failed), never store responses. */
export const EGRESS_HEADER = 'x-checkout-sentinel-egress';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) result[name] = value;
  }
  return result;
}

/** "host:port", with IPv6 hosts in brackets: how EgressEvent.target names a connection. */
export function formatTarget(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The target an http or https URL connects to, in EgressEvent.target form; null otherwise. */
export function targetOfUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return formatTarget(normalizeHost(url.hostname), port);
}

/** Parses a CONNECT target ("host:port", "[v6]:port"), normalizing the host like a URL does. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^([^/?#@\s]+):(\d{1,5})$/.exec(authority);
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  try {
    return { host: normalizeHost(new URL(`http://${match[1]}/`).hostname), port };
  } catch {
    return null;
  }
}

/**
 * Why a connection was refused or failed, as recorded in events and shown to the browser.
 * Refusals keep the guard's reason, which names the host but not where it points. Failures
 * are described by kind only: raw socket errors name the address that was dialled, and these
 * reasons reach the monitor's author through the run result.
 */
function describeError(error: unknown): string {
  if (error instanceof TargetBlockedError) return error.message;
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
    case 'EAI_NODATA':
    case 'EAI_NONAME':
      return 'the host name did not resolve';
    case 'ETIMEOUT':
      return 'the DNS lookup timed out';
    case 'ECONNREFUSED':
      return 'the connection was refused';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'the connection was reset';
    case 'ETIMEDOUT':
      return 'the connection timed out';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'the host is unreachable';
    default:
      return 'could not connect';
  }
}

const timedOut = (message: string) => Object.assign(new Error(message), { code: 'ETIMEDOUT' });

const MAX_EVENTS = 200;

export class EgressProxy {
  private readonly events: EgressEvent[] = [];
  private readonly sockets = new Set<Socket | Duplex>();

  private constructor(
    private readonly server: Server,
    private readonly guard: TargetGuard,
    private readonly options: EgressProxyOptions,
    readonly url: string,
  ) {}

  static async start(guard: TargetGuard, options: EgressProxyOptions): Promise<EgressProxy> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const proxy = new EgressProxy(server, guard, options, `http://127.0.0.1:${port}`);
    server.on('connection', (socket) => proxy.track(socket));
    server.on('request', (req, res) => proxy.forward(req, res));
    server.on('connect', (req, socket, head) => proxy.tunnel(req, socket, head));
    server.on('clientError', (_error, socket) => socket.destroy());
    return proxy;
  }

  /** Returns and clears the events recorded since the last call. */
  take(): EgressEvent[] {
    return this.events.splice(0, this.events.length);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private track(socket: Socket | Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private record(outcome: EgressEvent['outcome'], host: string, port: number, reason: string) {
    if (this.events.length >= MAX_EVENTS) return;
    const target = formatTarget(host, port);
    this.events.push({ at: new Date().toISOString(), target, host, outcome, reason });
  }

  /** HTTPS (and anything else Chromium tunnels): CONNECT host:port. */
  private tunnel(req: IncomingMessage, client: Duplex, head: Buffer): void {
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const verdict = this.guard.checkEndpoint(target.host, target.port);
    if (!verdict.allowed) {
      this.record('blocked', target.host, target.port, verdict.reason);
      client.end(`HTTP/1.1 403 Forbidden\r\n${EGRESS_HEADER}: blocked\r\n\r\n`);
      return;
    }

    let established = false;
    let clientGone = false;
    const upstream = connect({
      host: target.host,
      port: target.port,
      lookup: this.guard.lookup,
      timeout: this.options.connectTimeoutMs,
    });
    this.track(upstream);
    upstream.once('timeout', () => {
      if (!established) {
        upstream.destroy(timedOut(`connect timed out after ${this.options.connectTimeoutMs} ms`));
      }
    });
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error) => {
      if (established || clientGone) {
        client.destroy();
        return;
      }
      const isBlocked = error instanceof TargetBlockedError;
      this.record(isBlocked ? 'blocked' : 'failed', target.host, target.port, describeError(error));
      client.end(
        isBlocked
          ? `HTTP/1.1 403 Forbidden\r\n${EGRESS_HEADER}: blocked\r\n\r\n`
          : `HTTP/1.1 502 Bad Gateway\r\n${EGRESS_HEADER}: failed\r\n\r\n`,
      );
    });
    const dropUpstream = () => {
      clientGone = true;
      upstream.destroy();
    };
    client.on('error', dropUpstream);
    client.on('close', dropUpstream);
  }

  /** Plain HTTP: the browser sends the absolute URL in the request line. */
  private forward(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const host = normalizeHost(url.hostname);
    const port = Number(url.port || 80);
    const refuse = (outcome: EgressEvent['outcome'], reason: string) => {
      this.record(outcome, host, port, reason);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // The browser shows this page, so a failure screenshot explains itself.
      res
        .writeHead(outcome === 'blocked' ? 403 : 502, {
          'content-type': 'text/plain; charset=utf-8',
          [EGRESS_HEADER]: outcome,
        })
        .end(
          `checkout-sentinel ${outcome === 'blocked' ? 'blocked' : 'could not reach'} ${url.origin}: ${reason}\n`,
        );
    };

    const verdict = this.guard.checkEndpoint(host, port);
    if (!verdict.allowed) {
      req.resume();
      refuse('blocked', verdict.reason);
      return;
    }

    let clientGone = false;
    const upstream = httpRequest({
      host,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: endToEnd(req.headers),
      lookup: this.guard.lookup,
      agent: false,
      timeout: this.options.connectTimeoutMs,
    });
    upstream.once('socket', (socket) => this.track(socket));
    upstream.once('timeout', () => {
      upstream.destroy(timedOut(`no response within ${this.options.connectTimeoutMs} ms`));
    });
    upstream.once('response', (response) => {
      upstream.setTimeout(0);
      res.writeHead(response.statusCode ?? 502, response.statusMessage, endToEnd(response.headers));
      // pipe() would leave the browser waiting when the store drops the connection mid-body
      // (no 'end' arrives). pipeline() destroys the browser-facing response instead, so
      // Chromium fails it at once, as it would without the proxy.
      pipeline(response, res, () => undefined);
    });
    upstream.on('error', (error) => {
      if (clientGone) return;
      refuse(error instanceof TargetBlockedError ? 'blocked' : 'failed', describeError(error));
    });
    res.on('close', () => {
      clientGone = true;
      upstream.destroy();
    });
    req.pipe(upstream);
  }
}
