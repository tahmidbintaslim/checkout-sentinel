import { describe, expect, it, vi } from 'vitest';
import {
  STRICT_TARGET_POLICY,
  TargetBlockedError,
  TargetGuard,
  TargetPolicyEnvSchema,
  classifyAddress,
  isPublicAddress,
  parseIPv4,
  targetPolicyFromEnv,
  type AddressRange,
  type DnsRefusal,
  type ResolveHost,
  type ResolvedAddress,
} from '@checkout-sentinel/core';

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

/** A resolver with fixed answers; unknown names fail like NXDOMAIN. */
function fakeDns(answers: Record<string, ResolvedAddress[] | ResolvedAddress[][]>) {
  const calls: string[] = [];
  const counters = new Map<string, number>();
  const resolve: ResolveHost = async (hostname) => {
    calls.push(hostname);
    const answer = answers[hostname];
    if (!answer) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    // A list of lists answers differently on each call (DNS rebinding).
    if (Array.isArray(answer[0])) {
      const call = counters.get(hostname) ?? 0;
      counters.set(hostname, call + 1);
      const sequence = answer as ResolvedAddress[][];
      return sequence[Math.min(call, sequence.length - 1)] ?? [];
    }
    return answer as ResolvedAddress[];
  };
  return { resolve, calls };
}

describe('classifyAddress', () => {
  it.each<[string, AddressRange, string]>([
    // IPv4 in every form a URL host or inet_aton accepts.
    ['127.0.0.1', 'loopback', '127.0.0.1'],
    ['127.255.255.254', 'loopback', '127.255.255.254'],
    ['2130706433', 'loopback', '127.0.0.1'],
    ['0x7f000001', 'loopback', '127.0.0.1'],
    ['0X7F000001', 'loopback', '127.0.0.1'],
    ['017700000001', 'loopback', '127.0.0.1'],
    ['0x7f.0.0.1', 'loopback', '127.0.0.1'],
    ['0x7f.1', 'loopback', '127.0.0.1'],
    ['0177.0.0.1', 'loopback', '127.0.0.1'],
    ['0177.0.0.01', 'loopback', '127.0.0.1'],
    // Leading zeros do not count towards a part's length.
    ['0x0000000000007f.0.0.1', 'loopback', '127.0.0.1'],
    ['0000000000000177.0.0.1', 'loopback', '127.0.0.1'],
    ['00000000000000000000000000000000017700000001', 'loopback', '127.0.0.1'],
    ['0x00000000000000a9fea9fe', 'link-local', '169.254.169.254'],
    [`0x${'0'.repeat(64)}7f.1`, 'loopback', '127.0.0.1'],
    ['127.1', 'loopback', '127.0.0.1'],
    ['127.0.1', 'loopback', '127.0.0.1'],
    ['127.0.0.1.', 'loopback', '127.0.0.1'],
    ['0', 'unspecified', '0.0.0.0'],
    ['0.0.0.0', 'unspecified', '0.0.0.0'],
    ['0x0', 'unspecified', '0.0.0.0'],
    ['0.1.2.3', 'reserved', '0.1.2.3'],
    ['10.0.0.1', 'private', '10.0.0.1'],
    ['012.0.0.1', 'private', '10.0.0.1'],
    ['167772161', 'private', '10.0.0.1'],
    ['172.16.0.1', 'private', '172.16.0.1'],
    ['172.31.255.255', 'private', '172.31.255.255'],
    ['192.168.1.1', 'private', '192.168.1.1'],
    ['0xc0.0xa8.1.1', 'private', '192.168.1.1'],
    ['100.64.0.1', 'cgnat', '100.64.0.1'],
    ['100.127.255.255', 'cgnat', '100.127.255.255'],
    ['100.100.100.200', 'cgnat', '100.100.100.200'],
    ['169.254.169.254', 'link-local', '169.254.169.254'],
    ['2852039166', 'link-local', '169.254.169.254'],
    ['0xa9.0xfe.0xa9.0xfe', 'link-local', '169.254.169.254'],
    ['169.254.0.1', 'link-local', '169.254.0.1'],
    ['192.0.0.192', 'reserved', '192.0.0.192'],
    ['192.0.2.10', 'reserved', '192.0.2.10'],
    ['198.18.0.1', 'reserved', '198.18.0.1'],
    ['198.51.100.7', 'reserved', '198.51.100.7'],
    ['203.0.113.9', 'reserved', '203.0.113.9'],
    ['224.0.0.1', 'multicast', '224.0.0.1'],
    ['239.255.255.250', 'multicast', '239.255.255.250'],
    ['240.0.0.1', 'reserved', '240.0.0.1'],
    ['255.255.255.255', 'reserved', '255.255.255.255'],
    ['4294967295', 'reserved', '255.255.255.255'],
    // IPv6, with and without brackets and zone ids.
    ['::1', 'loopback', '::1'],
    ['[::1]', 'loopback', '::1'],
    ['0:0:0:0:0:0:0:1', 'loopback', '::1'],
    ['::1%lo', 'loopback', '::1'],
    ['::', 'unspecified', '::'],
    ['[::]', 'unspecified', '::'],
    ['fe80::1', 'link-local', 'fe80::1'],
    ['fe80::1%eth0', 'link-local', 'fe80::1'],
    ['[fe80::1%25eth0]', 'link-local', 'fe80::1'],
    ['FEBF::1', 'link-local', 'febf::1'],
    ['fc00::1', 'unique-local', 'fc00::1'],
    ['fd00:ec2::254', 'unique-local', 'fd00:ec2::254'],
    ['fec0::1', 'reserved', 'fec0::1'],
    ['ff02::1', 'multicast', 'ff02::1'],
    ['2001:db8::1', 'reserved', '2001:db8::1'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['100::1', 'reserved', '100::1'],
    ['::127.0.0.1', 'reserved', '::7f00:1'],
    ['1::1', 'reserved', '1::1'],
    // IPv4-mapped IPv6 is refused whatever it maps to.
    ['::ffff:127.0.0.1', 'ipv4-mapped', '::ffff:7f00:1'],
    ['::ffff:7f00:1', 'ipv4-mapped', '::ffff:7f00:1'],
    ['[::ffff:169.254.169.254]', 'ipv4-mapped', '::ffff:a9fe:a9fe'],
    ['::ffff:8.8.8.8', 'ipv4-mapped', '::ffff:808:808'],
    ['0:0:0:0:0:ffff:0a00:0001', 'ipv4-mapped', '::ffff:a00:1'],
    // NAT64 and 6to4 are as private as the IPv4 address inside.
    ['64:ff9b::a00:1', 'private', '64:ff9b::a00:1'],
    ['64:ff9b::127.0.0.1', 'loopback', '64:ff9b::7f00:1'],
    ['64:ff9b:1::1', 'reserved', '64:ff9b:1::1'],
    ['2002:7f00:1::1', 'loopback', '2002:7f00:1::1'],
    ['2002:a9fe:a9fe::', 'link-local', '2002:a9fe:a9fe::'],
  ])('%s is %s', (input, range, address) => {
    expect(classifyAddress(input)).toMatchObject({ range, address });
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.215.14',
    '172.32.0.1',
    '172.15.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '169.255.0.1',
    '192.169.0.1',
    '134744072',
    '0x08080808',
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (input) => {
    expect(classifyAddress(input)?.range).toBe('public');
    expect(isPublicAddress(input)).toBe(true);
  });

  it.each([
    'example.com',
    'localhost',
    '1.2.3.4.5',
    '256.0.0.1',
    '08.0.0.1',
    '0x7g.0.0.1',
    '1.2.3.com',
    '',
    '::ffff:1.2.3',
    '12345::1::2',
    '[::1',
  ])('%s is not an IP address', (input) => {
    expect(classifyAddress(input)).toBeNull();
  });

  it('explains why an address is refused', () => {
    expect(classifyAddress('169.254.169.254')?.description).toBe(
      '169.254.169.254 is the cloud metadata address, link-local (169.254.169.254/32)',
    );
    expect(classifyAddress('::ffff:10.0.0.1')?.description).toContain('IPv4-mapped');
    expect(classifyAddress('10.1.2.3')?.description).toBe(
      '10.1.2.3 is a private RFC 1918 address (10.0.0.0/8)',
    );
  });

  it('parses IPv4 numbers the way URL hosts do', () => {
    expect(parseIPv4('1.2.3')).toEqual(Uint8Array.of(1, 2, 0, 3));
    expect(parseIPv4('1.65538')).toEqual(Uint8Array.of(1, 1, 0, 2));
    expect(parseIPv4('4294967296')).toBeNull();
    expect(parseIPv4('1.2.3.256')).toBeNull();
    expect(parseIPv4('99999999999999999999')).toBeNull();
    expect(parseIPv4('0x0000000000000100000000')).toBeNull();
    expect(parseIPv4('0000000000000000040000000000')).toBeNull();
  });

  it('reads every host the WHATWG URL parser reads as IPv4 to the same address', () => {
    const inputs = [
      '127.0.0.1',
      '2130706433',
      '0x7f.1',
      '0177.0.0.1',
      '0x0000000000007f.0.0.1',
      '0000000000000177.0.0.1',
      '0x00000000000000a9fea9fe',
      '00000000000000000000000000000000017700000001',
      `0x${'0'.repeat(64)}7f.1`,
      '0x.0x.0x.0x',
      '0x0000000000000100000000',
      '4294967296',
      '1.2.3.256',
      '08.0.0.1',
      '1.2.3.com',
      'example.com',
    ];
    for (const input of inputs) {
      let whatwg: string | null;
      try {
        const hostname = new URL(`http://${input}/`).hostname;
        whatwg = /^[\d.]+$/.test(hostname) ? hostname : null;
      } catch {
        whatwg = null;
      }
      expect({ input, address: classifyAddress(input)?.address ?? null }).toEqual({
        input,
        address: whatwg,
      });
    }
  });
});

describe('TargetGuard.checkUrl', () => {
  const publicDns = fakeDns({
    'shop.example': [v4('93.184.215.14')],
    'hooks.slack.com': [v4('3.130.95.182')],
    'internal.example': [v4('10.20.30.40')],
    'dual.example': [v4('93.184.215.14'), v6('fd00::5')],
    'mapped.example': [v6('::ffff:127.0.0.1')],
    'metadata.example': [v4('169.254.169.254')],
  });
  const guard = new TargetGuard(STRICT_TARGET_POLICY, { resolve: publicDns.resolve });

  it('allows public http and https URLs on default ports', async () => {
    await expect(guard.checkUrl('https://shop.example/products/tee')).resolves.toEqual({
      allowed: true,
      resolved: true,
      addresses: ['93.184.215.14'],
    });
    expect((await guard.checkUrl('http://shop.example:443/p')).allowed).toBe(true);
    expect((await guard.checkUrl('https://93.184.215.14/p')).allowed).toBe(true);
  });

  it.each([
    ['ftp://shop.example/file', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['gopher://shop.example:70/', 'scheme'],
    ['not a url', 'invalid-url'],
    ['http://[fe80::1%25eth0]/', 'invalid-url'],
    ['https://user:secret@shop.example/p', 'credentials'],
    ['https://user@shop.example/p', 'credentials'],
    ['https://shop.example:8443/p', 'port'],
    ['http://shop.example:22/', 'port'],
    ['http://93.184.215.14:6379/', 'port'],
  ])('refuses %s (%s)', async (url, rule) => {
    expect(await guard.checkUrl(url)).toMatchObject({ allowed: false, rule });
  });

  it.each([
    'http://127.0.0.1/',
    'http://127.0.0.1:80/admin',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://017700000001/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://%31%32%37.0.0.1/',
    'http://0/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.0.1/',
    'http://224.0.0.251/',
    'http://localhost/',
    'http://LOCALHOST./',
    'http://shop.localhost/',
  ])('refuses the private target %s without asking DNS', async (url) => {
    const before = publicDns.calls.length;
    expect(await guard.checkUrl(url)).toMatchObject({ allowed: false, rule: 'address' });
    expect(publicDns.calls.length).toBe(before);
  });

  it.each([
    ['0x0000000000007f.0.0.1', '127.0.0.1 is a loopback address'],
    ['0000000000000177.0.0.1', '127.0.0.1 is a loopback address'],
    ['0x00000000000000a9fea9fe', '169.254.169.254 is the cloud metadata address'],
  ])(
    'checkEndpoint refuses the zero-padded host %s without a URL parser in front',
    (host, reason) => {
      expect(guard.checkEndpoint(host, 80)).toMatchObject({
        allowed: false,
        rule: 'address',
        reason: expect.stringContaining(reason),
      });
    },
  );

  it('refuses names that resolve to a private address without saying which address', async () => {
    const refusals: DnsRefusal[] = [];
    const logged = new TargetGuard(STRICT_TARGET_POLICY, {
      resolve: publicDns.resolve,
      onDnsRefusal: (refusal) => refusals.push(refusal),
    });
    expect(await logged.checkUrl('https://internal.example/hook', 'webhook')).toEqual({
      allowed: false,
      rule: 'address',
      reason: 'internal.example resolves to a private or internal address',
    });
    expect(await logged.checkUrl('https://metadata.example/')).toEqual({
      allowed: false,
      rule: 'address',
      reason: 'metadata.example resolves to a private or internal address',
    });
    expect(await logged.checkUrl('https://mapped.example/')).toEqual({
      allowed: false,
      rule: 'address',
      reason: 'mapped.example resolves to a private or internal address',
    });
    // The reason reaches API clients and stored results; the address goes to debug logs only.
    expect(refusals).toEqual([
      {
        host: 'internal.example',
        address: '10.20.30.40',
        range: 'private',
        label: 'a private RFC 1918 address (10.0.0.0/8)',
      },
      {
        host: 'metadata.example',
        address: '169.254.169.254',
        range: 'link-local',
        label: 'the cloud metadata address, link-local (169.254.169.254/32)',
      },
      expect.objectContaining({
        host: 'mapped.example',
        address: '::ffff:7f00:1',
        range: 'ipv4-mapped',
        label: expect.stringContaining('IPv4-mapped'),
      }),
    ]);
  });

  it('refuses a name when any of its addresses is private', async () => {
    const refusals: DnsRefusal[] = [];
    const logged = new TargetGuard(STRICT_TARGET_POLICY, {
      resolve: publicDns.resolve,
      onDnsRefusal: (refusal) => refusals.push(refusal),
    });
    expect(await logged.checkUrl('https://dual.example/')).toMatchObject({
      allowed: false,
      reason: 'dual.example resolves to a private or internal address',
    });
    expect(refusals).toEqual([
      expect.objectContaining({ address: 'fd00::5', range: 'unique-local' }),
    ]);
  });

  it('keeps the verdict when the refusal hook throws', async () => {
    const throwing = new TargetGuard(STRICT_TARGET_POLICY, {
      resolve: publicDns.resolve,
      onDnsRefusal: () => {
        throw new Error('logger down');
      },
    });
    expect(await throwing.checkUrl('https://internal.example/')).toMatchObject({
      allowed: false,
      rule: 'address',
    });
    await expect(throwing.resolveForConnection('internal.example')).rejects.toBeInstanceOf(
      TargetBlockedError,
    );
  });

  it('allows names that do not resolve; the use-time check decides again', async () => {
    expect(await guard.checkUrl('https://not-registered.example/p')).toEqual({
      allowed: true,
      resolved: false,
      addresses: [],
    });
  });

  it('gives up on slow DNS after the timeout', async () => {
    const slow = new TargetGuard(STRICT_TARGET_POLICY, {
      resolve: () => new Promise(() => undefined),
      resolveTimeoutMs: 20,
    });
    expect(await slow.checkUrl('https://slow.example/')).toMatchObject({
      allowed: true,
      resolved: false,
    });
    await expect(slow.resolveForConnection('slow.example')).rejects.toThrow(/timed out/);
  });

  it('requires Slack channels to be https://hooks.slack.com', async () => {
    expect(
      (await guard.checkUrl('https://hooks.slack.com/services/T0/B0/abc', 'slack')).allowed,
    ).toBe(true);
    for (const url of [
      'http://hooks.slack.com/services/T0/B0/abc',
      'https://hooks.slack.com:8443/services/T0/B0/abc',
      'https://hooks.slack.com.attacker.example/services/x',
      'https://attacker.example/hooks.slack.com/services/x',
      'https://shop.example/services/T0/B0/abc',
      'https://slack.com/services/T0/B0/abc',
    ]) {
      expect(await guard.checkUrl(url, 'slack')).toMatchObject({
        allowed: false,
        rule: 'slack-host',
      });
    }
    // Generic webhooks may point anywhere public.
    expect((await guard.checkUrl('https://shop.example/hook', 'webhook')).allowed).toBe(true);
  });
});

describe('TargetGuard policy options', () => {
  it('ALLOW_PRIVATE_TARGETS skips address, port and Slack checks but not scheme or credentials', async () => {
    const dns = fakeDns({});
    const local = new TargetGuard({ allowPrivate: true }, { resolve: dns.resolve });
    expect(local.permissive).toBe(true);
    expect((await local.checkUrl('http://127.0.0.1:4011/products/tee')).allowed).toBe(true);
    expect((await local.checkUrl('http://localhost:8080/')).allowed).toBe(true);
    expect((await local.checkUrl('http://127.0.0.1:9999/slack', 'slack')).allowed).toBe(true);
    expect((await local.checkUrl('ftp://127.0.0.1/')).allowed).toBe(false);
    expect((await local.checkUrl('http://u:p@127.0.0.1/')).allowed).toBe(false);
    expect(dns.calls).toEqual([]);
  });

  it('allowed hosts may be private but still need an allowed port', async () => {
    const dns = fakeDns({ 'relay.internal': [v4('10.0.0.9')] });
    const guard = new TargetGuard(
      { allowedHosts: ['Relay.Internal.', '10.1.1.1', '[FD00::1]'], allowedPorts: [8080] },
      { resolve: dns.resolve },
    );
    expect((await guard.checkUrl('http://relay.internal:8080/hook', 'webhook')).allowed).toBe(true);
    expect((await guard.checkUrl('http://10.1.1.1/')).allowed).toBe(true);
    expect((await guard.checkUrl('http://[fd00:0:0::1]/')).allowed).toBe(true);
    expect((await guard.checkUrl('http://relay.internal:9090/'))?.allowed).toBe(false);
    expect((await guard.checkUrl('http://10.1.1.2/')).allowed).toBe(false);
    // An allowed host is not a Slack host.
    expect((await guard.checkUrl('https://relay.internal/x', 'slack')).allowed).toBe(false);
    // Allowed hosts skip the address check, so DNS is not even asked.
    expect(dns.calls).toEqual([]);
    await expect(guard.resolveForConnection('relay.internal')).resolves.toEqual([v4('10.0.0.9')]);
  });

  it('parses the environment, defaulting to the strict policy', () => {
    expect(targetPolicyFromEnv(TargetPolicyEnvSchema.parse({}))).toEqual(STRICT_TARGET_POLICY);
    expect(
      targetPolicyFromEnv(
        TargetPolicyEnvSchema.parse({
          ALLOW_PRIVATE_TARGETS: 'true',
          ALLOWED_TARGET_PORTS: '8443, 8080',
          ALLOWED_TARGET_HOSTS: 'Relay.Internal., [fd00::1] ,',
        }),
      ),
    ).toEqual({
      allowPrivate: true,
      allowedPorts: [8443, 8080],
      allowedHosts: ['relay.internal', 'fd00::1'],
    });
    expect(TargetPolicyEnvSchema.safeParse({ ALLOW_PRIVATE_TARGETS: 'yes' }).success).toBe(false);
    expect(TargetPolicyEnvSchema.safeParse({ ALLOWED_TARGET_PORTS: '80,70000' }).success).toBe(
      false,
    );
    expect(TargetPolicyEnvSchema.safeParse({ ALLOWED_TARGET_PORTS: 'http' }).success).toBe(false);
  });
});

describe('DNS rebinding', () => {
  it('re-checks at use time: a name that was public when accepted and is private now', async () => {
    const dns = fakeDns({ 'rebind.example': [[v4('93.184.215.14')], [v4('127.0.0.1')]] });
    const guard = new TargetGuard(STRICT_TARGET_POLICY, { resolve: dns.resolve });
    expect((await guard.checkUrl('https://rebind.example/products/tee')).allowed).toBe(true);
    const later = await guard.checkUrl('https://rebind.example/products/tee');
    expect(later).toMatchObject({
      allowed: false,
      reason: 'rebind.example resolves to a private or internal address',
    });
  });

  it('the lookup handed to sockets refuses private answers, so the checked address is the one connected to', async () => {
    const dns = fakeDns({
      'rebind.example': [[v4('93.184.215.14')], [v4('10.0.0.1'), v4('93.184.215.14')]],
      'shop.example': [v6('2606:4700::6810:84e5'), v4('93.184.215.14')],
    });
    const guard = new TargetGuard(STRICT_TARGET_POLICY, { resolve: dns.resolve });
    const lookup = (hostname: string, options: { all?: boolean; family?: number }) =>
      new Promise<unknown>((resolve, reject) => {
        guard.lookup(hostname, options, (error, address, family) => {
          if (error) reject(error);
          else resolve(options.all ? address : { address, family });
        });
      });

    // First connection: the answer is public.
    await expect(lookup('rebind.example', {})).resolves.toEqual({
      address: '93.184.215.14',
      family: 4,
    });
    // Second connection: the same name now includes a private address and is refused.
    const refused = await lookup('rebind.example', {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TargetBlockedError);
    expect((refused as TargetBlockedError).code).toBe('ETARGETBLOCKED');
    expect((refused as TargetBlockedError).message).toBe(
      'rebind.example resolves to a private or internal address',
    );

    await expect(lookup('shop.example', { all: true })).resolves.toEqual([
      v6('2606:4700::6810:84e5'),
      v4('93.184.215.14'),
    ]);
    await expect(lookup('shop.example', { family: 4 })).resolves.toEqual({
      address: '93.184.215.14',
      family: 4,
    });
    await expect(lookup('localhost', {})).rejects.toBeInstanceOf(TargetBlockedError);
    await expect(lookup('0x7f.1', {})).rejects.toBeInstanceOf(TargetBlockedError);
    await expect(lookup('nowhere.example', {})).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('checks a redirect Location like any other target', async () => {
    // What the egress proxy does for each hop: the Location of a public page is checked
    // like any other target before the browser may connect to it.
    const dns = fakeDns({ 'shop.example': [v4('93.184.215.14')] });
    const guard = new TargetGuard(STRICT_TARGET_POLICY, { resolve: dns.resolve });
    const first = new URL('https://shop.example/products/tee');
    expect((await guard.checkUrl(first)).allowed).toBe(true);
    for (const location of [
      'http://127.0.0.1/admin',
      '//169.254.169.254/latest/meta-data/',
      'http://[::1]:80/',
      'http://localhost/',
    ]) {
      const hop = new URL(location, first);
      expect(guard.checkEndpoint(hop.hostname, Number(hop.port || 80))).toMatchObject({
        allowed: false,
        rule: 'address',
      });
    }
  });

  it('never calls DNS for literals and refuses a resolver that returns garbage', async () => {
    const resolve = vi.fn<ResolveHost>(async () => [{ address: 'not-an-ip', family: 4 }]);
    const guard = new TargetGuard(STRICT_TARGET_POLICY, { resolve });
    await guard.checkUrl('http://10.0.0.1/');
    expect(resolve).not.toHaveBeenCalled();
    expect(await guard.checkUrl('https://weird.example/')).toMatchObject({ allowed: false });
  });
});
