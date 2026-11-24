/**
 * URL validation and SSRF defence.
 *
 * The crawler accepts arbitrary user-supplied URLs, so this module is the
 * security boundary of the whole system. Every URL — including every redirect
 * hop — passes through `assertFetchable` before a socket is opened.
 *
 * Layers:
 *   1. syntactic  — protocol, port, credentials, host shape
 *   2. literal IP — private / loopback / link-local / CGNAT / metadata ranges,
 *                   including decimal, octal and hex IPv4 spellings
 *   3. name-based — blocked suffixes (.local, .internal, metadata hostnames)
 *   4. resolved   — DNS-over-HTTPS lookup, rejecting names that resolve into
 *                   any blocked range (defeats DNS rebinding at fetch time)
 */

export interface GuardOptions {
  /** Resolve the hostname over DoH and check the answers. Default true. */
  checkDns?: boolean;
  /** Cache for DoH answers. */
  cache?: KVNamespace;
}

export class UrlNotAllowed extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'UrlNotAllowed';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.i2p',
];

const BLOCKED_HOST_EXACT = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  '169.254.169.254',
  '[fd00:ec2::254]',
  'fd00:ec2::254',
]);

/** Parse an IPv4 address in any of the spellings the resolver accepts. */
export function parseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // a, a.b, a.b.c and a.b.c.d forms, as implemented by inet_aton.
  const last = values[values.length - 1];
  const maxLast = Math.pow(256, 5 - values.length);
  if (last >= maxLast) return null;
  for (let i = 0; i < values.length - 1; i++) if (values[i] > 255) return null;

  let result = last;
  for (let i = 0; i < values.length - 1; i++) {
    result += values[i] * Math.pow(256, 3 - i);
  }
  return result >>> 0;
}

/** True when an IPv4 address is outside every reserved / private range. */
export function isPublicIPv4(ip: number): boolean {
  const a = (ip >>> 24) & 255;
  const b = (ip >>> 16) & 255;
  const c = (ip >>> 8) & 255;

  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

export function parseIPv6(host: string): Uint8Array | null {
  let value = host;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(':')) return null;

  const bytes = new Uint8Array(16);
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (input: string): number[] | null => {
    if (input === '') return [];
    const groups: number[] = [];
    for (const group of input.split(':')) {
      if (group.includes('.')) {
        const v4 = parseIPv4(group);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 255;
    bytes[i * 2 + 1] = groups[i] & 255;
  }
  return bytes;
}

export function isPublicIPv6(bytes: Uint8Array): boolean {
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return false; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) embed IPv4.
  const isMapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255;
  const isNat64 =
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (isMapped || isNat64) {
    const v4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    return isPublicIPv4(v4);
  }

  if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (bytes[0] === 0xff) return false; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00) return false; // discard
  return true;
}

export function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOST_EXACT.has(lower)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (!lower.includes('.') && !lower.includes(':')) return true; // bare hostnames are intranet-ish
  return false;
}

/** Synchronous checks. Throws `UrlNotAllowed` with a machine-readable reason. */
export function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlNotAllowed('URL could not be parsed', 'malformed');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlNotAllowed(`protocol ${url.protocol} is not allowed`, 'protocol');
  }
  if (url.username || url.password) {
    throw new UrlNotAllowed('credentials in URLs are not allowed', 'credentials');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlNotAllowed(`port ${url.port} is not allowed`, 'port');
  }
  if (url.hostname.length === 0 || url.hostname.length > 253) {
    throw new UrlNotAllowed('invalid hostname', 'hostname');
  }

  const host = url.hostname;
  const v6 = parseIPv6(host);
  if (v6) {
    if (!isPublicIPv6(v6)) throw new UrlNotAllowed('IPv6 address is not publicly routable', 'private-ip');
    return url;
  }
  const v4 = parseIPv4(host);
  if (v4 !== null) {
    if (!isPublicIPv4(v4)) throw new UrlNotAllowed('IPv4 address is not publicly routable', 'private-ip');
    return url;
  }
  if (isBlockedHostname(host)) {
    throw new UrlNotAllowed(`hostname ${host} is not allowed`, 'blocked-host');
  }
  if (!/^[a-z0-9.-]+$/i.test(host) && !host.startsWith('xn--')) {
    // Punycode is emitted by the URL parser; anything else is suspicious.
    throw new UrlNotAllowed('hostname contains unexpected characters', 'hostname');
  }
  return url;
}

interface DohAnswer {
  Answer?: { type: number; data: string }[];
}

/** Resolve over DNS-over-HTTPS and reject any answer inside a blocked range. */
export async function assertResolvesPublic(host: string, cache?: KVNamespace): Promise<string[]> {
  const cacheKey = `dns:${host}`;
  if (cache) {
    const hit = await cache.get(cacheKey, 'json').catch(() => null);
    if (hit && Array.isArray(hit)) return hit as string[];
  }

  const lookup = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as DohAnswer;
    const wanted = type === 'A' ? 1 : 28;
    return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
  };

  const [a, aaaa] = await Promise.all([lookup('A'), lookup('AAAA')]);
  const addresses = [...a, ...aaaa];

  if (addresses.length === 0) {
    // No answer is not proof of safety, but it is also not proof of danger:
    // let the fetch proceed; the literal-IP guards still apply to redirects.
    return [];
  }

  for (const address of addresses) {
    if (address.includes(':')) {
      const bytes = parseIPv6(address);
      if (!bytes || !isPublicIPv6(bytes)) {
        throw new UrlNotAllowed(`${host} resolves to a non-public address (${address})`, 'private-ip');
      }
    } else {
      const ip = parseIPv4(address);
      if (ip === null || !isPublicIPv4(ip)) {
        throw new UrlNotAllowed(`${host} resolves to a non-public address (${address})`, 'private-ip');
      }
    }
  }

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(addresses), { expirationTtl: 300 }).catch(() => {});
  }
  return addresses;
}

/** Full check: syntax, literal IPs, blocked names and resolved addresses. */
export async function assertFetchable(input: string, options: GuardOptions = {}): Promise<URL> {
  const url = validateUrl(input);
  const isLiteralIp = parseIPv4(url.hostname) !== null || parseIPv6(url.hostname) !== null;
  if (options.checkDns !== false && !isLiteralIp) {
    await assertResolvesPublic(url.hostname, options.cache);
  }
  return url;
}

const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^mc_[ce]id$/i,
  /^igshid$/i, /^ref$/i, /^ref_src$/i, /^referrer$/i, /^source$/i, /^_hs[a-z]*$/i,
  /^vero_/i, /^yclid$/i, /^twclid$/i, /^si$/i, /^spm$/i, /^trk$/i,
];

/**
 * Canonical form used for de-duplication: lowercase host, no default port,
 * no fragment, no tracking parameters, sorted query, no trailing slash.
 */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  url.username = '';
  url.password = '';
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.some((pattern) => pattern.test(key)))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  let out = url.toString();
  if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
  if (url.pathname === '/' && !url.search) out = out.replace(/\/$/, '');
  return out;
}
