/**
 * A minimal, dependency-free PNG encoder (indexed colour, 4 bits per pixel).
 *
 * Two variants share one container writer:
 *   encodeIndexedPng       synchronous, stored (uncompressed) deflate blocks.
 *                          Valid and trivially correct, but ~380 KB for a card.
 *   encodeIndexedPngAsync  real deflate via the platform CompressionStream
 *                          (Workers and Node both have it). A flat 16-colour
 *                          card shrinks to a few KB, which matters because
 *                          some unfurlers give up on large og:images.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** zlib stream using stored (uncompressed) deflate blocks. */
function zlibStore(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 65535;
  for (let offset = 0; offset < data.length || offset === 0; offset += MAX) {
    const slice = data.subarray(offset, Math.min(offset + MAX, data.length));
    const isLast = offset + MAX >= data.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = isLast;
    header[1] = slice.length & 0xff;
    header[2] = (slice.length >> 8) & 0xff;
    header[3] = ~slice.length & 0xff;
    header[4] = (~slice.length >> 8) & 0xff;
    blocks.push(header, slice);
    if (isLast) break;
  }
  const bodyLength = blocks.reduce((total, block) => total + block.length, 0);
  const out = new Uint8Array(2 + bodyLength + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let cursor = 2;
  for (const block of blocks) {
    out.set(block, cursor);
    cursor += block.length;
  }
  new DataView(out.buffer).setUint32(cursor, adler32(data));
  return out;
}

export interface IndexedImage {
  width: number;
  height: number;
  /** One palette index per pixel, row-major. */
  pixels: Uint8Array;
  /** Up to 16 colours, as [r,g,b] triples. */
  palette: [number, number, number][];
}

export function encodeIndexedPng(image: IndexedImage): Uint8Array {
  return assemble(image, zlibStore(packRows(image)));
}

export async function encodeIndexedPngAsync(image: IndexedImage): Promise<Uint8Array> {
  return assemble(image, await zlibDeflate(packRows(image)));
}

/** zlib (RFC 1950) stream. CompressionStream's "deflate" format is zlib-wrapped. */
async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packRows(image: IndexedImage): Uint8Array {
  const { width, height, pixels } = image;
  const bytesPerRow = Math.ceil(width / 2);
  const raw = new Uint8Array((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 2) {
      const high = pixels[y * width + x] & 0x0f;
      const low = x + 1 < width ? pixels[y * width + x + 1] & 0x0f : 0;
      raw[rowStart + 1 + (x >> 1)] = (high << 4) | low;
    }
  }
  return raw;
}

function assemble(image: IndexedImage, idat: Uint8Array): Uint8Array {
  const { width, height, palette } = image;
  if (palette.length > 16) throw new Error('palette must hold at most 16 colours');

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 4; // bit depth
  ihdr[9] = 3; // colour type: indexed
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((color, index) => {
    plte[index * 3] = color[0];
    plte[index * 3 + 1] = color[1];
    plte[index * 3 + 2] = color[2];
  });

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Simple indexed drawing surface. */
export class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background = 0,
  ) {
    this.pixels = new Uint8Array(width * height).fill(background);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let row = y0; row < y1; row++) {
      this.pixels.fill(color, row * this.width + x0, row * this.width + x1);
    }
  }
}
