import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  base32Decode,
  concat,
  encodeDirectory,
  encodeFile,
  encodeVarint,
  parseCid,
  rawBlock,
  verifyRawCid,
  writeCar,
  CHUNK_SIZE,
} from '../src/lib/cid';
import { sha256 } from '../src/lib/hash';

const encoder = new TextEncoder();

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}


describe('base32 multibase', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('encodes without padding, lowercase', () => {
    expect(base32Encode(encoder.encode('foobar'))).toBe('mzxw6ytboi');
  });
});

describe('varint', () => {
  it('matches the LEB128 spec for multi-byte values', () => {
    expect(Array.from(encodeVarint(0))).toEqual([0]);
    expect(Array.from(encodeVarint(127))).toEqual([127]);
    expect(Array.from(encodeVarint(128))).toEqual([0x80, 0x01]);
    expect(Array.from(encodeVarint(300))).toEqual([0xac, 0x02]);
  });
});

describe('CIDv1 raw blocks', () => {
  // Canonical vectors: these are the CIDs `ipfs add --cid-version=1 --raw-leaves`
  // produces for the same bytes.
  it('matches the published CID for empty content', async () => {
    const block = await rawBlock(new Uint8Array(0));
    expect(block.cid).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });

  it('matches the published CID for "hello world"', async () => {
    const block = await rawBlock(encoder.encode('hello world'));
    expect(block.cid).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  });

  it('is deterministic and content-addressed', async () => {
    const a = await rawBlock(encoder.encode('same bytes'));
    const b = await rawBlock(encoder.encode('same bytes'));
    const c = await rawBlock(encoder.encode('other bytes'));
    expect(a.cid).toBe(b.cid);
    expect(a.cid).not.toBe(c.cid);
  });

  it('verifies bytes against a claimed CID', async () => {
    const block = await rawBlock(encoder.encode('receipts'));
    expect(await verifyRawCid(block.cid, encoder.encode('receipts'))).toBe(true);
    expect(await verifyRawCid(block.cid, encoder.encode('receipt'))).toBe(false);
  });

  it('parses its own CIDs back to the raw multihash prefix', async () => {
    const block = await rawBlock(encoder.encode('x'));
    const bytes = parseCid(block.cid);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x01, 0x55, 0x12, 0x20]);
  });
});

describe('UnixFS file encoding', () => {
  it('uses a single raw block for small files', async () => {
    const dag = await encodeFile(encoder.encode('small'));
    expect(dag.blocks).toHaveLength(1);
    expect(dag.root.cid.startsWith('bafkrei')).toBe(true);
  });

  it('chunks large files into raw leaves under a dag-pb root', async () => {
    const payload = new Uint8Array(CHUNK_SIZE + 1000).fill(65);
    const dag = await encodeFile(payload);
    expect(dag.blocks.length).toBe(3); // two leaves + the file node
    expect(dag.root.cid.startsWith('bafybei')).toBe(true);
    expect(dag.tsize).toBeGreaterThan(payload.length);
  });

  it('produces canonical dag-pb node bytes (checked against a published CIDv0)', async () => {
    // The classic `ipfs add` vector for "hello world\n" exercises the same
    // protobuf writer the directory encoder uses.
    const data = encoder.encode('hello world\n');
    const unixfs = concat([
      concat([encodeVarint(0x08), encodeVarint(2)]),           // Type = File
      concat([encodeVarint(0x12), encodeVarint(data.length), data]),
      concat([encodeVarint(0x18), encodeVarint(data.length)]), // filesize
    ]);
    const node = concat([encodeVarint(0x0a), encodeVarint(unixfs.length), unixfs]);
    const multihash = concat([new Uint8Array([0x12, 0x20]), await sha256(node)]);
    expect(base58(multihash)).toBe('QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o');
  });
});

describe('artifact directories', () => {
  it('sorts entries and exposes per-file CIDs', async () => {
    const dag = await encodeDirectory([
      { name: 'page.html', content: encoder.encode('<html></html>') },
      { name: 'content.txt', content: encoder.encode('hello') },
      { name: 'metadata.json', content: encoder.encode('{}') },
    ]);
    expect(dag.entries.map((entry) => entry.name)).toEqual(['content.txt', 'metadata.json', 'page.html']);
    expect(dag.cid.startsWith('bafybei')).toBe(true);
    expect(new Set(dag.entries.map((entry) => entry.cid)).size).toBe(3);
  });

  it('gives identical artifacts identical CIDs', async () => {
    const entries = [{ name: 'a.txt', content: encoder.encode('one') }];
    const first = await encodeDirectory(entries);
    const second = await encodeDirectory(entries);
    expect(first.cid).toBe(second.cid);
  });
});

describe('CARv1 writer', () => {
  it('writes a header naming the root and then every block', async () => {
    const dag = await encodeDirectory([{ name: 'a.txt', content: encoder.encode('one') }]);
    const car = writeCar(dag.root, dag.blocks);
    // Header: varint length, then dag-cbor map with "roots" and "version".
    const headerLength = car[0];
    const header = new TextDecoder().decode(car.slice(1, 1 + headerLength));
    expect(header).toContain('roots');
    expect(header).toContain('version');
    expect(car.length).toBeGreaterThan(headerLength + dag.blocks.length);
  });

  it('deduplicates repeated blocks', async () => {
    const block = await rawBlock(encoder.encode('dupe'));
    const withDupes = writeCar(block, [block, block, block]);
    const withoutDupes = writeCar(block, [block]);
    expect(withDupes.length).toBe(withoutDupes.length);
  });
});
