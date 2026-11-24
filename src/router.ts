/** A tiny pattern router — no framework, no dependencies. */
import type { Env } from './types';
import { Repo } from './db/repo';

export interface Ctx {
  request: Request;
  env: Env;
  executionCtx: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  repo: Repo;
  baseUrl: string;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler) { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler) { return this.add('POST', pattern, handler); }
  patch(pattern: string, handler: Handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern: string, handler: Handler) { return this.add('DELETE', pattern, handler); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue;
      const wildcard = route.segments[route.segments.length - 1] === '*';
      if (!wildcard && route.segments.length !== parts.length) continue;
      if (wildcard && parts.length < route.segments.length - 1) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        if (segment === '*') {
          params['*'] = parts.slice(i).join('/');
          break;
        }
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
          continue;
        }
        if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

export function json(data: unknown, init: ResponseInit = {}, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...(cacheSeconds ? { 'cache-control': `public, max-age=30, s-maxage=${cacheSeconds}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export function problem(status: number, message: string, detail?: unknown): Response {
  return json({ error: message, detail, status }, { status });
}

export function redirect(location: string, status = 303, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { location, ...headers } });
}

/** Read a form or JSON body into a flat record. */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const parsed = (await request.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && value !== undefined && typeof value !== 'object') out[key] = String(value);
        else if (value && typeof value === 'object') out[key] = JSON.stringify(value);
      }
      return out;
    }
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) out[key] = String(value);
    return out;
  } catch {
    return {};
  }
}
