import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EGRESS_HEADER,
  EgressProxy,
  TargetGuard,
  parseAuthority,
  type ResolveHost,
} from '@checkout-sentinel/core';

// Everything here stays on 127.0.0.1: "store.test" is an allowed host that the fake resolver
// points at the local origin server, and nothing is ever resolved through real DNS.
let origin: Server;
let originPort = 0;
let proxy: EgressProxy;
let proxyPort = 0;
let rebindCalls = 0;

const resolve: ResolveHost = async (hostname) => {
  if (hostname === 'store.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'rebind.test') {
    rebindCalls += 1;
    // Public when first checked, loopback by the time the proxy connects.
    return [{ address: rebindCalls === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }];
  }
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
};

let guard: TargetGuard;

beforeAll(async () => {
  origin = createServer((req, res) => {
    if (req.url === '/redirect-to-loopback') {
      res.writeHead(302, { location: `http://127.0.0.1:${originPort}/hello` }).end();
      return;
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(body));
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] })
      .end(`hello from ${req.headers.host}`);
  });
  await new Promise<void>((done) => origin.listen(0, '127.0.0.1', done));
  originPort = (origin.address() as AddressInfo).port;
  guard = new TargetGuard(
    { allowedHosts: ['store.test'], allowedPorts: [originPort] },
    { resolve },
  );
  proxy = await EgressProxy.start(guard, { connectTimeoutMs: 2_000 });
  proxyPort = Number(new URL(proxy.url).port);
});

afterAll(async () => {
  await proxy?.close();
  await new Promise<void>((done) => origin.close(() => done()));
});

beforeEach(() => {
  proxy.take();
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A plain HTTP request through the proxy, the way Chromium sends one (absolute URL). */
function viaProxy(url: string, method = 'GET', body?: string): Promise<Reply> {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const req = request(
      { host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: target.host } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

/** Opens a CONNECT tunnel; resolves with the proxy's status and the tunnel socket. */
function connectVia(authority: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((done, fail) => {
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
    });
    req.on('connect', (res, socket) => done({ status: res.statusCode ?? 0, socket }));
    req.on('error', fail);
    req.end();
  });
}

describe('EgressProxy, plain HTTP', () => {
  it('forwards requests to allowed hosts, bodies and repeated headers included', async () => {
    const reply = await viaProxy(`http://store.test:${originPort}/hello`);
    expect(reply).toMatchObject({ status: 200, body: `hello from store.test:${originPort}` });
    expect(reply.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    const echo = await viaProxy(`http://store.test:${originPort}/echo`, 'POST', 'quantity=1');
    expect(echo.body).toBe('quantity=1');
    expect(proxy.take()).toEqual([]);
  });

  it('answers 403 for a private address and records the block', async () => {
    const reply = await viaProxy(`http://127.0.0.1:${originPort}/hello`);
    expect(reply.status).toBe(403);
    expect(reply.headers[EGRESS_HEADER]).toBe('blocked');
    expect(reply.body).toContain('127.0.0.1 is a loopback address');
    expect(proxy.take()).toEqual([
      expect.objectContaining({
        target: `127.0.0.1:${originPort}`,
        host: '127.0.0.1',
        outcome: 'blocked',
      }),
    ]);
  });

  it('checks every redirect hop: a public page redirecting to 127.0.0.1 gets no further', async () => {
    const first = await viaProxy(`http://store.test:${originPort}/redirect-to-loopback`);
    expect(first.status).toBe(302);
    const location = first.headers.location ?? '';
    expect(location).toBe(`http://127.0.0.1:${originPort}/hello`);
    // The browser follows the redirect with a new request through the same proxy.
    const hop = await viaProxy(new URL(location, `http://store.test:${originPort}/`).toString());
    expect(hop.status).toBe(403);
    expect(proxy.take()).toEqual([expect.objectContaining({ outcome: 'blocked' })]);
  });

  it('refuses disallowed ports before connecting', async () => {
    const reply = await viaProxy('http://93.184.215.14:6379/');
    expect(reply.status).toBe(403);
    expect(reply.body).toContain('Port 6379 is not allowed');
  });

  it('reports unresolvable hosts as failed, not blocked', async () => {
    const reply = await viaProxy('http://nowhere.test/');
    expect(reply.status).toBe(502);
    expect(reply.headers[EGRESS_HEADER]).toBe('failed');
    expect(proxy.take()).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining('ENOTFOUND') }),
    ]);
  });
});

describe('EgressProxy, CONNECT tunnels', () => {
  it('tunnels to allowed hosts', async () => {
    const { status, socket } = await connectVia(`store.test:${originPort}`);
    expect(status).toBe(200);
    const response = await new Promise<string>((done) => {
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => done(text));
      socket.write(`GET /hello HTTP/1.1\r\nhost: store.test\r\nconnection: close\r\n\r\n`);
    });
    expect(response).toContain('hello from store.test');
    expect(proxy.take()).toEqual([]);
  });

  it.each([
    [() => `127.0.0.1:${originPort}`, 'loopback'],
    [() => `localhost:${originPort}`, 'local machine'],
    [() => `[::1]:${originPort}`, 'loopback'],
    [() => `[::ffff:127.0.0.1]:${originPort}`, 'IPv4-mapped'],
    [() => `2130706433:${originPort}`, 'loopback'],
    [() => '169.254.169.254:80', 'cloud metadata'],
    [() => '10.0.0.1:443', 'private'],
    [() => '93.184.215.14:22', 'Port 22'],
  ])('refuses %s', async (authority, reason) => {
    const { status, socket } = await connectVia(authority());
    socket.destroy();
    expect(status).toBe(403);
    expect(proxy.take()).toEqual([
      expect.objectContaining({ outcome: 'blocked', reason: expect.stringContaining(reason) }),
    ]);
  });

  it('connects only to the address it checked (DNS rebinding)', async () => {
    rebindCalls = 0;
    // Accepted earlier, when the name answered with a public address.
    expect((await guard.checkUrl('https://rebind.test/products/tee')).allowed).toBe(true);
    // At connection time the same name answers 127.0.0.1; the proxy refuses it.
    const { status, socket } = await connectVia('rebind.test:443');
    socket.destroy();
    expect(status).toBe(403);
    expect(proxy.take()).toEqual([
      expect.objectContaining({
        target: 'rebind.test:443',
        outcome: 'blocked',
        reason: 'rebind.test resolves to 127.0.0.1, a loopback address (127.0.0.0/8)',
      }),
    ]);
  });

  it('answers 502 when the host does not resolve and 400 for a malformed target', async () => {
    const missing = await connectVia('nowhere.test:443');
    missing.socket.destroy();
    expect(missing.status).toBe(502);
    expect(proxy.take()).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    const malformed = await connectVia('store.test');
    malformed.socket.destroy();
    expect(malformed.status).toBe(400);
  });
});

describe('parseAuthority', () => {
  it('normalizes hosts like a URL and requires a port', () => {
    expect(parseAuthority('Store.Test:443')).toEqual({ host: 'store.test', port: 443 });
    expect(parseAuthority('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    expect(parseAuthority('0x7f.1:80')).toEqual({ host: '127.0.0.1', port: 80 });
    expect(parseAuthority('store.test')).toBeNull();
    expect(parseAuthority('store.test:0')).toBeNull();
    expect(parseAuthority('store.test:70000')).toBeNull();
    expect(parseAuthority('user@store.test:443')).toBeNull();
    expect(parseAuthority('store.test/path:443')).toBeNull();
  });
});
