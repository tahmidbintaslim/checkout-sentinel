import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv6, type LookupFunction } from 'node:net';
import { z } from 'zod';

/**
 * Server-side request forgery (SSRF) protection for every URL the system fetches on a user's
 * behalf: monitor product URLs (the browser journey), webhook alert URLs and Slack webhook URLs.
 *
 * Checks run when a URL is accepted (API input) and again when it is used, because DNS answers
 * can change between the two. At use time the checked addresses are the ones connected to:
 * alert deliveries and the journey's egress proxy pass `TargetGuard.lookup` to the socket, so
 * a name cannot answer with a public address to the check and a private one to the connection.
 */

export type AddressRange =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link-local'
  | 'unique-local'
  | 'ipv4-mapped'
  | 'multicast'
  | 'reserved';

export interface AddressClassification {
  /** Canonical text form (dotted decimal, or compressed IPv6 without brackets or zone). */
  address: string;
  version: 4 | 6;
  range: AddressRange;
  /** What the address is, for example "a loopback address (127.0.0.0/8)". */
  label: string;
  /** The address and its label, for example "127.0.0.1 is a loopback address (127.0.0.0/8)". */
  description: string;
}

interface RangeRule {
  network: Uint8Array;
  bits: number;
  range: Exclude<AddressRange, 'public'>;
  label: string;
}

/**
 * Parses an IPv4 address the way the WHATWG URL parser (and so Chromium) does: one to four
 * dot-separated parts, each decimal, octal (leading 0) or hex (0x), with the last part filling
 * the remaining bytes. "2130706433", "0x7f.1" and "0177.0.0.1" are all 127.0.0.1.
 */
export function parseIPv4(input: string): Uint8Array | null {
  const parts = input.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIPv4Part(part);
    if (value === null) return null;
    numbers.push(value);
  }
  const last = numbers[numbers.length - 1] ?? 0;
  const leading = numbers.slice(0, -1);
  if (leading.some((value) => value > 255)) return null;
  if (last >= 256 ** (5 - numbers.length)) return null;
  let value = last;
  leading.forEach((part, index) => {
    value += part * 256 ** (3 - index);
  });
  return Uint8Array.of(
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  );
}

function parseIPv4Part(part: string): number | null {
  if (part === '') return null;
  let radix = 10;
  let digits = part;
  if (/^0x/i.test(part)) {
    radix = 16;
    digits = part.slice(2);
  } else if (part.length > 1 && part.startsWith('0')) {
    radix = 8;
    digits = part.slice(1);
  }
  if (digits === '') return 0;
  const pattern = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  // The URL parser reads "0x00000000007f" as 0x7f, so padding must not count towards the
  // length. More than 12 significant digits overflow every IPv4 part, and capping there
  // keeps parseInt in exact range.
  const significant = digits.replace(/^0+(?=.)/, '');
  if (significant.length > 12) return Number.POSITIVE_INFINITY;
  return Number.parseInt(significant, radix);
}

/** Parses an IPv6 address, with or without brackets; a zone id ("%eth0") is ignored. */
export function parseIPv6(input: string): Uint8Array | null {
  let text = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!isIPv6(text)) return null;

  const groupsOf = (segment: string): number[] => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const group of segment.split(':')) {
      if (group.includes('.')) {
        const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
        groups.push(a * 256 + b, c * 256 + d);
      } else {
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };

  const doubleColon = text.indexOf('::');
  let groups: number[];
  if (doubleColon === -1) {
    groups = groupsOf(text);
  } else {
    const head = groupsOf(text.slice(0, doubleColon));
    const tail = groupsOf(text.slice(doubleColon + 2));
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function cidr(text: string, range: RangeRule['range'], label: string): RangeRule {
  const [address = '', bits = ''] = text.split('/');
  const network = text.includes(':') ? parseIPv6(address) : parseIPv4(address);
  if (!network) throw new Error(`Bad CIDR in range table: ${text}`);
  return { network, bits: Number(bits), range, label: `${label} (${text})` };
}

function inRange(address: Uint8Array, rule: RangeRule): boolean {
  if (address.length !== rule.network.length) return false;
  const fullBytes = Math.floor(rule.bits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (address[i] !== rule.network[i]) return false;
  }
  const remaining = rule.bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((address[fullBytes] ?? 0) & mask) === ((rule.network[fullBytes] ?? 0) & mask);
}

// IANA IPv4 special-purpose registry, plus multicast and the old class E space. The most
// specific rule comes first.
const IPV4_RULES: readonly RangeRule[] = [
  cidr('0.0.0.0/32', 'unspecified', 'the unspecified address'),
  cidr('0.0.0.0/8', 'reserved', '"this network"'),
  cidr('10.0.0.0/8', 'private', 'a private RFC 1918 address'),
  cidr('100.64.0.0/10', 'cgnat', 'a carrier-grade NAT (shared) address'),
  cidr('127.0.0.0/8', 'loopback', 'a loopback address'),
  cidr('169.254.169.254/32', 'link-local', 'the cloud metadata address, link-local'),
  cidr('169.254.0.0/16', 'link-local', 'a link-local address'),
  cidr('172.16.0.0/12', 'private', 'a private RFC 1918 address'),
  cidr('192.0.0.0/24', 'reserved', 'reserved for IETF protocol assignments'),
  cidr('192.0.2.0/24', 'reserved', 'reserved for documentation'),
  cidr('192.88.99.0/24', 'reserved', 'a deprecated 6to4 relay address'),
  cidr('192.168.0.0/16', 'private', 'a private RFC 1918 address'),
  cidr('198.18.0.0/15', 'reserved', 'reserved for benchmarking'),
  cidr('198.51.100.0/24', 'reserved', 'reserved for documentation'),
  cidr('203.0.113.0/24', 'reserved', 'reserved for documentation'),
  cidr('224.0.0.0/4', 'multicast', 'a multicast address'),
  cidr('255.255.255.255/32', 'reserved', 'the broadcast address'),
  cidr('240.0.0.0/4', 'reserved', 'reserved'),
];

const IPV6_RULES: readonly RangeRule[] = [
  cidr('::/128', 'unspecified', 'the unspecified address'),
  cidr('::1/128', 'loopback', 'the loopback address'),
  cidr('64:ff9b:1::/48', 'reserved', 'a local-use NAT64 address'),
  cidr('100::/64', 'reserved', 'a discard-only address'),
  cidr('2001:db8::/32', 'reserved', 'reserved for documentation'),
  cidr('2001::/23', 'reserved', 'reserved for IETF protocol assignments (including Teredo)'),
  cidr('3fff::/20', 'reserved', 'reserved for documentation'),
  cidr('5f00::/16', 'reserved', 'reserved for SRv6'),
  cidr('fc00::/7', 'unique-local', 'a unique-local address'),
  cidr('fe80::/10', 'link-local', 'a link-local address'),
  cidr('fec0::/10', 'reserved', 'a deprecated site-local address'),
  cidr('ff00::/8', 'multicast', 'a multicast address'),
];

const IPV4_MAPPED = cidr('::ffff:0:0/96', 'reserved', 'IPv4-mapped');
const NAT64 = cidr('64:ff9b::/96', 'reserved', 'NAT64');
const SIX_TO_FOUR = cidr('2002::/16', 'reserved', '6to4');
const GLOBAL_UNICAST = cidr('2000::/3', 'reserved', 'global unicast');

function formatIPv4(bytes: Uint8Array): string {
  return Array.from(bytes).join('.');
}

function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  // The WHATWG URL serializer produces the canonical compressed form.
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

function classified(
  address: string,
  version: 4 | 6,
  range: AddressRange,
  label: string,
): AddressClassification {
  return { address, version, range, label, description: `${address} is ${label}` };
}

function classifyIPv4Bytes(bytes: Uint8Array): AddressClassification {
  const address = formatIPv4(bytes);
  const rule = IPV4_RULES.find((candidate) => inRange(bytes, candidate));
  return rule
    ? classified(address, 4, rule.range, rule.label)
    : classified(address, 4, 'public', 'a public address');
}

function classifyIPv6Bytes(bytes: Uint8Array): AddressClassification {
  const address = formatIPv6(bytes);
  if (inRange(bytes, IPV4_MAPPED)) {
    const embedded = formatIPv4(bytes.slice(12));
    return classified(address, 6, 'ipv4-mapped', `an IPv4-mapped IPv6 address (for ${embedded})`);
  }
  // NAT64 and 6to4 addresses carry an IPv4 address; they are as private as the one inside.
  const embedded = inRange(bytes, NAT64)
    ? { kind: 'NAT64', v4: bytes.slice(12) }
    : inRange(bytes, SIX_TO_FOUR)
      ? { kind: '6to4', v4: bytes.slice(2, 6) }
      : null;
  if (embedded) {
    const inner = classifyIPv4Bytes(embedded.v4);
    if (inner.range === 'public') return classified(address, 6, 'public', 'a public address');
    return classified(
      address,
      6,
      inner.range,
      `a ${embedded.kind} address for ${inner.address}, ${inner.label}`,
    );
  }
  const rule = IPV6_RULES.find((candidate) => inRange(bytes, candidate));
  if (rule) return classified(address, 6, rule.range, rule.label);
  if (!inRange(bytes, GLOBAL_UNICAST)) {
    return classified(address, 6, 'reserved', 'outside the global unicast range (2000::/3)');
  }
  return classified(address, 6, 'public', 'a public address');
}

/**
 * Classifies an IP address literal. Accepts every IPv4 form a URL host can take (decimal,
 * octal, hex, shortened) and IPv6 with or without brackets and zone id. Returns null when the
 * input is not an IP address (a host name).
 */
export function classifyAddress(input: string): AddressClassification | null {
  const text = input.trim().toLowerCase();
  const v6 = parseIPv6(text);
  if (v6) return classifyIPv6Bytes(v6);
  const v4 = parseIPv4(text);
  if (v4) return classifyIPv4Bytes(v4);
  return null;
}

export function isPublicAddress(input: string): boolean {
  return classifyAddress(input)?.range === 'public';
}

// --- Policy ---------------------------------------------------------------------------------

export interface TargetPolicy {
  /**
   * Local development and fixture tests only: skips the address, port and Slack host checks.
   * Scheme and credential checks still apply.
   */
  allowPrivate: boolean;
  /** Ports allowed besides 80 and 443. */
  allowedPorts: readonly number[];
  /** Host names or IP literals (exact match) that may resolve to private addresses. */
  allowedHosts: readonly string[];
}

export const STRICT_TARGET_POLICY: TargetPolicy = Object.freeze({
  allowPrivate: false,
  allowedPorts: [],
  allowedHosts: [],
});

export const DEFAULT_TARGET_PORTS: readonly number[] = [80, 443];

/** What a URL is fetched for. Slack channels must point at Slack. */
export type TargetKind = 'store' | 'webhook' | 'slack';

export type TargetRule =
  'invalid-url' | 'scheme' | 'credentials' | 'slack-host' | 'port' | 'address';

export type TargetVerdict =
  | {
      allowed: true;
      /** False when DNS did not answer; the use-time check decides again. */
      resolved: boolean;
      /** Addresses that were checked (empty for allowlisted hosts and when not resolved). */
      addresses: string[];
    }
  | { allowed: false; rule: TargetRule; reason: string };

export class TargetBlockedError extends Error {
  readonly code = 'ETARGETBLOCKED';

  constructor(
    readonly rule: TargetRule,
    reason: string,
  ) {
    super(reason);
    this.name = 'TargetBlockedError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address the system resolver returns. */
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolveHost: ResolveHost = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: 'verbatim' })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

export interface TargetGuardOptions {
  /** Replaces the system resolver (tests). */
  resolve?: ResolveHost;
  /** Default 5000 ms. */
  resolveTimeoutMs?: number;
}

/** Lowercases, removes IPv6 brackets and one trailing dot, so "LOCALHOST." matches "localhost". */
export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  return value;
}

const ok = (resolved: boolean, addresses: string[] = []): TargetVerdict => ({
  allowed: true,
  resolved,
  addresses,
});
const blocked = (rule: TargetRule, reason: string): TargetVerdict => ({
  allowed: false,
  rule,
  reason,
});

type HostCheck =
  { kind: 'allowed' } | { kind: 'blocked'; reason: string } | { kind: 'needs-dns'; host: string };

export class TargetGuard {
  readonly policy: TargetPolicy;
  private readonly hosts: ReadonlySet<string>;
  private readonly ports: ReadonlySet<number>;
  private readonly resolveHost: ResolveHost;
  private readonly resolveTimeoutMs: number;

  constructor(policy: Partial<TargetPolicy> = {}, options: TargetGuardOptions = {}) {
    this.policy = {
      allowPrivate: policy.allowPrivate ?? false,
      allowedPorts: [...(policy.allowedPorts ?? [])],
      allowedHosts: [...(policy.allowedHosts ?? [])],
    };
    this.hosts = new Set(
      this.policy.allowedHosts.map((host) => classifyAddress(host)?.address ?? normalizeHost(host)),
    );
    this.ports = new Set([...DEFAULT_TARGET_PORTS, ...this.policy.allowedPorts]);
    this.resolveHost = options.resolve ?? systemResolveHost;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? 5_000;
  }

  /** True when private targets are allowed (local development): no address or port checks. */
  get permissive(): boolean {
    return this.policy.allowPrivate;
  }

  private checkHost(rawHost: string): HostCheck {
    if (this.policy.allowPrivate) return { kind: 'allowed' };
    const host = normalizeHost(rawHost);
    if (this.hosts.has(host)) return { kind: 'allowed' };
    const literal = classifyAddress(host);
    if (literal) {
      if (this.hosts.has(literal.address)) return { kind: 'allowed' };
      return literal.range === 'public'
        ? { kind: 'allowed' }
        : { kind: 'blocked', reason: literal.description };
    }
    // Chromium answers *.localhost with loopback itself, without asking DNS.
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return { kind: 'blocked', reason: `${host} always points at the local machine (loopback)` };
    }
    return { kind: 'needs-dns', host };
  }

  private checkPort(port: number): TargetVerdict | null {
    if (this.policy.allowPrivate || this.ports.has(port)) return null;
    return blocked(
      'port',
      `Port ${port} is not allowed; only ports ${[...this.ports].sort((a, b) => a - b).join(', ')} are`,
    );
  }

  /** Checks a host and port about to be connected to (the egress proxy's CONNECT target). */
  checkEndpoint(host: string, port: number): TargetVerdict {
    const hostCheck = this.checkHost(host);
    if (hostCheck.kind === 'blocked') return blocked('address', hostCheck.reason);
    return this.checkPort(port) ?? ok(false);
  }

  /** Everything that needs no DNS: scheme, credentials, Slack host, port and IP literals. */
  checkUrlSync(input: string | URL, kind: TargetKind = 'store'): TargetVerdict {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : input;
    } catch {
      return blocked('invalid-url', 'Not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return blocked('scheme', `Only http and https URLs are allowed, got ${url.protocol}`);
    }
    if (url.username !== '' || url.password !== '') {
      return blocked('credentials', 'URLs must not contain a user name or password');
    }
    if (kind === 'slack' && !this.policy.allowPrivate) {
      if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' || url.port !== '') {
        return blocked('slack-host', 'Slack channel URLs must start with https://hooks.slack.com/');
      }
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return this.checkEndpoint(url.hostname, port);
  }

  /**
   * Full check: the synchronous rules, then DNS. Every address a name resolves to must be
   * public. A name that does not resolve is allowed here, because it cannot be connected to
   * either; the use-time check runs again before any connection.
   */
  async checkUrl(input: string | URL, kind: TargetKind = 'store'): Promise<TargetVerdict> {
    const verdict = this.checkUrlSync(input, kind);
    if (!verdict.allowed) return verdict;
    const url = typeof input === 'string' ? new URL(input) : input;
    const hostCheck = this.checkHost(url.hostname);
    if (hostCheck.kind !== 'needs-dns') return ok(false);
    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolveWithTimeout(hostCheck.host);
    } catch {
      return ok(false);
    }
    const problem = this.firstNonPublic(hostCheck.host, addresses);
    if (problem) return blocked('address', problem);
    return ok(
      addresses.length > 0,
      addresses.map((entry) => entry.address),
    );
  }

  private firstNonPublic(host: string, addresses: readonly ResolvedAddress[]): string | null {
    for (const entry of addresses) {
      const classification = classifyAddress(entry.address);
      if (!classification) return `${host} resolved to something that is not an IP address`;
      if (classification.range !== 'public') {
        return `${host} resolves to ${classification.address}, ${classification.label}`;
      }
    }
    return null;
  }

  private async resolveWithTimeout(host: string): Promise<ResolvedAddress[]> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(
            new Error(`DNS lookup for ${host} timed out after ${this.resolveTimeoutMs} ms`),
            {
              code: 'ETIMEOUT',
            },
          ),
        );
      }, this.resolveTimeoutMs);
    });
    try {
      return await Promise.race([this.resolveHost(host), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolves a host for a connection and refuses non-public answers. Throws
   * TargetBlockedError, or the resolver's own error (for example ENOTFOUND).
   */
  async resolveForConnection(rawHost: string): Promise<ResolvedAddress[]> {
    const hostCheck = this.checkHost(rawHost);
    if (hostCheck.kind === 'blocked') throw new TargetBlockedError('address', hostCheck.reason);
    const host = normalizeHost(rawHost);
    const literal = classifyAddress(host);
    if (literal) return [{ address: literal.address, family: literal.version }];
    const addresses = await this.resolveWithTimeout(host);
    if (addresses.length === 0) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }
    if (hostCheck.kind === 'needs-dns') {
      const problem = this.firstNonPublic(host, addresses);
      if (problem) throw new TargetBlockedError('address', problem);
    }
    return addresses;
  }

  /**
   * A drop-in `lookup` for net.connect, http.request and https.request. The socket connects
   * only to addresses this guard has just checked, which closes the gap between checking a
   * name and connecting to it (DNS rebinding).
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    this.resolveForConnection(hostname).then(
      (addresses) => {
        const family =
          options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const wanted =
          family === 4 || family === 6
            ? addresses.filter((entry) => entry.family === family)
            : addresses;
        const first = wanted[0];
        if (!first) {
          callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }),
            '',
          );
          return;
        }
        if (options.all) callback(null, wanted);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), '');
      },
    );
  };
}

// --- Environment ----------------------------------------------------------------------------

const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/**
 * The SSRF settings shared by the API and the worker. Everything is off by default, which is
 * the production setting; ALLOW_PRIVATE_TARGETS=true is for local development and tests.
 */
export const TargetPolicyEnvSchema = z.object({
  ALLOW_PRIVATE_TARGETS: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .default(false),
  /** Comma-separated ports allowed besides 80 and 443, for example "8443,8080". */
  ALLOWED_TARGET_PORTS: z
    .string()
    .transform((value, ctx) => {
      const ports = commaList(value).map(Number);
      const bad = ports.filter((port) => !Number.isInteger(port) || port < 1 || port > 65535);
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: 'Must be comma-separated ports from 1 to 65535' });
        return z.NEVER;
      }
      return ports;
    })
    .default([]),
  /** Comma-separated host names or IP literals that may resolve to private addresses. */
  ALLOWED_TARGET_HOSTS: z
    .string()
    .transform((value) => commaList(value).map(normalizeHost))
    .default([]),
});
export type TargetPolicyEnv = z.infer<typeof TargetPolicyEnvSchema>;

export function targetPolicyFromEnv(env: TargetPolicyEnv): TargetPolicy {
  return {
    allowPrivate: env.ALLOW_PRIVATE_TARGETS,
    allowedPorts: env.ALLOWED_TARGET_PORTS,
    allowedHosts: env.ALLOWED_TARGET_HOSTS,
  };
}
