import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  isBlockedHostname,
  isPublicIPv4,
  isPublicIPv6,
  parseIPv4,
  parseIPv6,
  UrlNotAllowed,
  validateUrl,
} from '../src/lib/urlguard';

function reasonFor(url: string): string {
  try {
    validateUrl(url);
    return 'allowed';
  } catch (error) {
    return error instanceof UrlNotAllowed ? error.reason : 'unknown';
  }
}

describe('IPv4 parsing across spellings', () => {
  it('parses dotted quads', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('8.8.8.8')).toBe(0x08080808);
  });

  it('parses the inet_aton short forms an attacker would reach for', () => {
    expect(parseIPv4('2130706433')).toBe(0x7f000001); // decimal
    expect(parseIPv4('0x7f000001')).toBe(0x7f000001); // hex
    expect(parseIPv4('0177.0.0.1')).toBe(0x7f000001); // octal
    expect(parseIPv4('127.1')).toBe(0x7f000001); // a.d
  });

  it('rejects non-addresses', () => {
    expect(parseIPv4('example.com')).toBeNull();
    expect(parseIPv4('999.1.1.1')).toBeNull();
    expect(parseIPv4('')).toBeNull();
  });
});

describe('public address classification', () => {
  it('rejects every reserved IPv4 range', () => {
    const blocked = [
      '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254',
      '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1',
      '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1',
      '255.255.255.255',
    ];
    for (const address of blocked) {
      expect(isPublicIPv4(parseIPv4(address)!), address).toBe(false);
    }
  });

  it('accepts ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isPublicIPv4(parseIPv4(address)!), address).toBe(true);
    }
  });

  it('rejects reserved IPv6, including IPv4-mapped and NAT64 forms', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '2002::1', '::ffff:127.0.0.1', '64:ff9b::169.254.169.254']) {
      const bytes = parseIPv6(address);
      expect(bytes, address).not.toBeNull();
      expect(isPublicIPv6(bytes!), address).toBe(false);
    }
  });

  it('accepts public IPv6', () => {
    expect(isPublicIPv6(parseIPv6('2606:4700:4700::1111')!)).toBe(true);
  });
});

describe('hostname policy', () => {
  it('blocks intranet-ish and metadata names', () => {
    for (const host of ['localhost', 'metadata.google.internal', 'db.internal', 'printer.local', 'router', 'foo.onion']) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('allows ordinary public names', () => {
    for (const host of ['example.com', 'sub.example.co.uk', 'openai.com']) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});

describe('validateUrl', () => {
  it('accepts normal http(s) URLs', () => {
    expect(reasonFor('https://example.com/pricing')).toBe('allowed');
    expect(reasonFor('http://example.com:8080/x')).toBe('allowed');
  });

  it('rejects non-HTTP protocols', () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com', 'data:text/html,x']) {
      expect(reasonFor(url), url).toBe('protocol');
    }
  });

  it('rejects credentials in the URL', () => {
    expect(reasonFor('https://user:pass@example.com/')).toBe('credentials');
  });

  it('rejects unusual ports', () => {
    expect(reasonFor('http://example.com:22/')).toBe('port');
    expect(reasonFor('http://example.com:6379/')).toBe('port');
  });

  it('rejects private and metadata literals in every spelling', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[fd00:ec2::254]/',
      'http://192.168.0.1/',
    ]) {
      expect(reasonFor(url), url).toBe('private-ip');
    }
  });

  it('rejects loopback and internal hostnames', () => {
    expect(reasonFor('http://localhost:8080/')).toBe('blocked-host');
    expect(reasonFor('http://metadata.google.internal/')).toBe('blocked-host');
  });
});

describe('canonicalizeUrl', () => {
  it('strips tracking parameters, fragments and default ports', () => {
    expect(canonicalizeUrl('https://Example.com:443/pricing?utm_source=x&plan=pro#top')).toBe(
      'https://example.com/pricing?plan=pro',
    );
  });

  it('sorts query parameters so equivalent URLs collapse', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1')).toBe(canonicalizeUrl('https://example.com/a?a=1&b=2'));
  });

  it('normalizes bare hosts', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com');
  });
});
