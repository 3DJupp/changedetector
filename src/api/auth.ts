/**
 * Admin authentication.
 *
 * Deliberately minimal for v1: a single shared token, presented either as a
 * bearer header (API) or held in an HttpOnly cookie (console). No user
 * accounts, no password reset flows, nothing to over-engineer yet.
 */
import type { Env } from '../types';
import { sha256Hex, timingSafeEqual } from '../lib/hash';

const COOKIE = 'cd_admin';

export async function adminCookieValue(env: Env): Promise<string> {
  return (await sha256Hex(`admin:${env.ADMIN_TOKEN ?? ''}`)).slice(0, 40);
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;

  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    if (timingSafeEqual(header.slice(7).trim(), env.ADMIN_TOKEN)) return true;
  }

  const cookies = request.headers.get('cookie') ?? '';
  const match = cookies.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return false;
  return timingSafeEqual(match.slice(COOKIE.length + 1), await adminCookieValue(env));
}

export async function loginCookie(env: Env, secure: boolean): Promise<string> {
  const value = await adminCookieValue(env);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`;
}

export function logoutCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
