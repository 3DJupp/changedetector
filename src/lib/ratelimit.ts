/**
 * Coarse per-client rate limiting for public forms, kept in KV.
 *
 * KV is eventually consistent, so this is a brake, not an exact counter. The
 * client address is hashed with the bucket name before it is stored; no raw
 * IP addresses end up in KV.
 */
import { sha256Hex } from './hash';

export async function overLimit(
  kv: KVNamespace | undefined,
  request: Request,
  bucket: string,
  max: number,
  windowSeconds = 3600,
): Promise<boolean> {
  if (!kv) return false;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${(await sha256Hex(`${bucket}|${ip}|${window}`)).slice(0, 32)}`;
  const current = Number.parseInt((await kv.get(key).catch(() => null)) ?? '0', 10) || 0;
  if (current >= max) return true;
  await kv.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds) }).catch(() => undefined);
  return false;
}
