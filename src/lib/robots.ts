/**
 * robots.txt fetching, parsing and caching.
 *
 * The crawler is a good citizen by default: a disallowed path is never
 * fetched, and Crawl-delay raises the per-domain spacing.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) {
      current = { agents: ['*'], rules: [] };
      groups.push(current);
    }
    if (field === 'disallow') current.rules.push({ type: 'disallow', path: value });
    else if (field === 'allow') current.rules.push({ type: 'allow', path: value });
    else if (field === 'crawl-delay') {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = Math.min(delay, 300);
    }
  }
  return { groups, sitemaps };
}

function matchesPattern(path: string, pattern: string): number {
  // Returns match length, or -1. Supports the de-facto '*' and '$' extensions.
  if (pattern === '') return -1;
  if (!pattern.includes('*') && !pattern.includes('$')) {
    return path.startsWith(pattern) ? pattern.length : -1;
  }
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp('^' + escaped + (anchored ? '$' : ''));
  return regex.test(path) ? body.replace(/\*/g, '').length : -1;
}

function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestScore = -1;
  for (const group of robots.groups) {
    for (const candidate of group.agents) {
      if (candidate === '*') {
        if (bestScore < 0) {
          best = group;
          bestScore = 0;
        }
      } else if (agent.includes(candidate) && candidate.length > bestScore) {
        best = group;
        bestScore = candidate.length;
      }
    }
  }
  return best;
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelay?: number;
  matchedRule?: string;
}

export function isAllowed(robots: RobotsTxt, userAgent: string, pathWithQuery: string): RobotsDecision {
  const group = selectGroup(robots, userAgent);
  if (!group) return { allowed: true };

  let decision: RobotsDecision = { allowed: true, crawlDelay: group.crawlDelay };
  let bestLength = -1;
  for (const rule of group.rules) {
    if (rule.type === 'disallow' && rule.path === '') continue; // "Disallow:" means allow all
    const length = matchesPattern(pathWithQuery, rule.path);
    if (length > bestLength) {
      bestLength = length;
      decision = {
        allowed: rule.type === 'allow',
        crawlDelay: group.crawlDelay,
        matchedRule: `${rule.type}: ${rule.path}`,
      };
    }
  }
  return decision;
}

const ROBOTS_TTL_S = 43200; // 12 hours
const ROBOTS_MAX_BYTES = 512 * 1024;

/** Fetch and cache robots.txt for an origin. Failures fail open, as per RFC 9309. */
export async function getRobots(
  origin: string,
  userAgent: string,
  cache?: KVNamespace,
): Promise<RobotsTxt> {
  const key = `robots:${origin}`;
  if (cache) {
    const cached = await cache.get(key).catch(() => null);
    if (cached !== null) return parseRobots(cached);
  }
  let text = '';
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (response.ok) {
      const body = await response.text();
      text = body.slice(0, ROBOTS_MAX_BYTES);
    } else if (response.status === 401 || response.status === 403) {
      // Access to robots.txt itself is restricted: treat the site as off-limits.
      text = 'User-agent: *\nDisallow: /';
    }
  } catch {
    text = '';
  }
  if (cache) await cache.put(key, text, { expirationTtl: ROBOTS_TTL_S }).catch(() => {});
  return parseRobots(text);
}
