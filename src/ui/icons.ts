/**
 * Favicon, touch icons and the web app manifest, drawn from the same mark as
 * the inline brand: a red square on near-black. Rendered on demand and cached
 * by the edge; they are a few hundred bytes each.
 */
import { Canvas, encodeIndexedPngAsync } from '../lib/png';
import { SITE_NAME } from './seo';

const PALETTE: [number, number, number][] = [
  [14, 17, 22], // background
  [242, 84, 91], // red mark
];

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0E1116"/><rect x="9" y="9" width="14" height="14" fill="#F2545B"/></svg>`;

/** Square icon with the mark at 14/32 of the size, centred. */
export async function iconPng(size: number, padding = 0): Promise<Uint8Array> {
  const canvas = new Canvas(size, size, 0);
  const inner = size - padding * 2;
  const mark = Math.round((inner * 14) / 32);
  const offset = Math.round((size - mark) / 2);
  canvas.fillRect(offset, offset, mark, mark, 1);
  return encodeIndexedPngAsync({ width: size, height: size, pixels: canvas.pixels, palette: PALETTE });
}

/** An .ico container holding one PNG image (supported by every current browser). */
export function icoFromPng(png: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(6 + 16 + png.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, 1, true); // one image
  out[6] = size >= 256 ? 0 : size;
  out[7] = size >= 256 ? 0 : size;
  out[8] = 0; // palette size (0 for PNG)
  out[9] = 0;
  view.setUint16(10, 1, true); // colour planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true); // offset of the image data
  out.set(png, 22);
  return out;
}

export function webManifest(): string {
  return JSON.stringify(
    {
      name: SITE_NAME,
      short_name: 'Change Detector',
      description: 'See what changed on important web pages, when, and what it looked like before.',
      start_url: '/',
      display: 'standalone',
      background_color: '#0E1116',
      theme_color: '#0E1116',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
}
