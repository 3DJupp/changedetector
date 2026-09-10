/**
 * Content addressing.
 *
 * Snapshots are addressed by the hash of their bytes, not by a provider URL.
 * These helpers produce genuine IPFS CIDs (CIDv1, sha2-256) for raw blocks,
 * UnixFS files and UnixFS directories, plus a CARv1 writer so a snapshot
 * artifact can be handed to *any* IPFS implementation or pinning service.
 *
 * Because the CID is derived from the bytes alone, an artifact stored in R2
 * has the same CID it would have on IPFS: the storage provider is replaceable
 * without breaking a single published reference.
 */
import { sha256 } from './hash';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, unpadded — multibase 'b'. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Uint8Array {
  const clean = str.toLowerCase().replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

/** Unsigned LEB128, as used by multiformats and CAR. */
export function encodeVarint(n: number): Uint8Array {
  if (n < 0 || !Number.isSafeInteger(n)) throw new Error('varint out of range');
  const bytes: number[] = [];
  let value = n;
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return new Uint8Array(bytes);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;

/** Build the binary form of a CIDv1: <version><codec><multihash>. */
export function cidBytes(codec: number, digest: Uint8Array): Uint8Array {
  return concat([
    encodeVarint(1),
    encodeVarint(codec),
    encodeVarint(0x12), // sha2-256
    encodeVarint(digest.length),
    digest,
  ]);
}

/** Render CID bytes as a base32 multibase string ("bafy…" / "bafk…"). */
export function formatCid(bytes: Uint8Array): string {
  return 'b' + base32Encode(bytes);
}

export function parseCid(cid: string): Uint8Array {
  if (!cid || cid[0] !== 'b') throw new Error('only base32 CIDv1 is supported');
  return base32Decode(cid.slice(1));
}

export interface Block {
  cid: string;
  bytes: Uint8Array; // block payload
  cidRaw: Uint8Array;
}

async function makeBlock(codec: number, payload: Uint8Array): Promise<Block> {
  const digest = await sha256(payload);
  const raw = cidBytes(codec, digest);
  return { cid: formatCid(raw), bytes: payload, cidRaw: raw };
}

/** CIDv1 of a raw block (`ipfs add --cid-version 1 --raw-leaves`). */
export async function rawBlock(payload: Uint8Array): Promise<Block> {
  return makeBlock(CODEC_RAW, payload);
}

// --- protobuf helpers -------------------------------------------------------

function pbKey(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

function pbBytes(field: number, value: Uint8Array): Uint8Array {
  return concat([pbKey(field, 2), encodeVarint(value.length), value]);
}

function pbString(field: number, value: string): Uint8Array {
  return pbBytes(field, new TextEncoder().encode(value));
}

function pbUint(field: number, value: number): Uint8Array {
  return concat([pbKey(field, 0), encodeVarint(value)]);
}

/** UnixFS `Data` message. Type 1 = Directory, 2 = File. */
function unixfsData(type: number, filesize?: number, blocksizes?: number[]): Uint8Array {
  const parts = [pbUint(1, type)];
  if (filesize !== undefined) parts.push(pbUint(3, filesize));
  for (const b of blocksizes ?? []) parts.push(pbUint(4, b));
  return concat(parts);
}

export interface PbLink {
  name: string;
  cidRaw: Uint8Array;
  /** Cumulative size of the linked sub-DAG. */
  tsize: number;
}

/** dag-pb node. Canonical field order is Links (2) before Data (1). */
function dagPbNode(links: PbLink[], data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const link of links) {
    const inner = concat([
      pbBytes(1, link.cidRaw),
      pbString(2, link.name),
      pbUint(3, link.tsize),
    ]);
    parts.push(pbBytes(2, inner));
  }
  parts.push(pbBytes(1, data));
  return concat(parts);
}

export const CHUNK_SIZE = 262144; // 256 KiB, matching the IPFS default chunker

export interface FileDag {
  root: Block;
  blocks: Block[];
  /** Cumulative dag size, used as Tsize by the parent directory. */
  tsize: number;
}

/**
 * Encode a file the way `ipfs add --cid-version 1` does: a single raw block
 * when it fits in one chunk, otherwise a UnixFS file node over raw leaves.
 */
export async function encodeFile(payload: Uint8Array): Promise<FileDag> {
  if (payload.length <= CHUNK_SIZE) {
    const block = await rawBlock(payload);
    return { root: block, blocks: [block], tsize: payload.length };
  }
  const leaves: Block[] = [];
  const links: PbLink[] = [];
  const blocksizes: number[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    const slice = payload.subarray(offset, Math.min(offset + CHUNK_SIZE, payload.length));
    const leaf = await rawBlock(slice);
    leaves.push(leaf);
    links.push({ name: '', cidRaw: leaf.cidRaw, tsize: slice.length });
    blocksizes.push(slice.length);
  }
  const node = dagPbNode(links, unixfsData(2, payload.length, blocksizes));
  const root = await makeBlock(CODEC_DAG_PB, node);
  const tsize = node.length + payload.length;
  return { root, blocks: [...leaves, root], tsize };
}

export interface DirEntry {
  name: string;
  content: Uint8Array;
}

export interface DirDag {
  cid: string;
  root: Block;
  blocks: Block[];
  entries: { name: string; cid: string; size: number }[];
}

/**
 * Encode a snapshot artifact directory:
 *   snapshot/{metadata.json, page.html, content.txt, screenshot.png}
 * Entries are sorted by name, as dag-pb directories require.
 */
export async function encodeDirectory(entries: DirEntry[]): Promise<DirDag> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blocks: Block[] = [];
  const links: PbLink[] = [];
  const manifest: { name: string; cid: string; size: number }[] = [];

  for (const entry of sorted) {
    const file = await encodeFile(entry.content);
    blocks.push(...file.blocks);
    links.push({ name: entry.name, cidRaw: file.root.cidRaw, tsize: file.tsize });
    manifest.push({ name: entry.name, cid: file.root.cid, size: entry.content.length });
  }

  const node = dagPbNode(links, unixfsData(1));
  const root = await makeBlock(CODEC_DAG_PB, node);
  blocks.push(root);
  return { cid: root.cid, root, blocks, entries: manifest };
}

// --- CARv1 ------------------------------------------------------------------

/** Minimal dag-cbor encoding of `{ roots: [cid], version: 1 }`. */
function carHeader(rootCid: Uint8Array): Uint8Array {
  const cidBytesWithPrefix = concat([new Uint8Array([0x00]), rootCid]);
  const parts: Uint8Array[] = [
    new Uint8Array([0xa2]), // map(2)
    new Uint8Array([0x65]), // text(5)
    new TextEncoder().encode('roots'),
    new Uint8Array([0x81]), // array(1)
    new Uint8Array([0xd8, 0x2a]), // tag(42) = CID
  ];
  const len = cidBytesWithPrefix.length;
  if (len < 24) parts.push(new Uint8Array([0x40 | len]));
  else parts.push(new Uint8Array([0x58, len]));
  parts.push(cidBytesWithPrefix);
  parts.push(new Uint8Array([0x67])); // text(7)
  parts.push(new TextEncoder().encode('version'));
  parts.push(new Uint8Array([0x01]));
  return concat(parts);
}

/**
 * Serialize blocks as a CARv1 archive. This is the interchange format every
 * IPFS implementation understands, so the ContentStore stays provider-neutral.
 */
export function writeCar(root: Block, blocks: Block[]): Uint8Array {
  const header = carHeader(root.cidRaw);
  const parts: Uint8Array[] = [encodeVarint(header.length), header];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.cid)) continue;
    seen.add(block.cid);
    const body = concat([block.cidRaw, block.bytes]);
    parts.push(encodeVarint(body.length), body);
  }
  return concat(parts);
}

/** Verify that bytes actually hash to the CID they claim. */
export async function verifyRawCid(cid: string, payload: Uint8Array): Promise<boolean> {
  const block = await rawBlock(payload);
  return block.cid === cid;
}
