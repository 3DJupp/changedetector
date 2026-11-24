/** Cloudflare bindings and configuration available to the Worker. */
export interface Env {
  // --- Bindings -----------------------------------------------------------
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  /** Job queue. Optional: without it the scheduler falls back to inline processing. */
  JOBS?: Queue<Job>;
  /** Workers AI. Optional: the analysis layer degrades to heuristics without it. */
  AI?: { run: (model: string, input: unknown) => Promise<any> };
  /** Browser Rendering binding, used only for JS-heavy pages and OG cards. */
  BROWSER?: unknown;
  /** Vectorize index for semantic search. Optional: search falls back to full text only. */
  VECTORS?: VectorizeIndex;

  // --- Vars ---------------------------------------------------------------
  PUBLIC_BASE_URL: string;
  TOOL_VERSION: string;
  USER_AGENT: string;
  CONTENT_STORE: string;
  IPFS_GATEWAY: string;
  IPFS_API_URL: string;
  AI_MODEL: string;
  AI_EMBEDDING_MODEL: string;
  MAX_RESPONSE_BYTES: string;
  FETCH_TIMEOUT_MS: string;
  DOMAIN_MIN_INTERVAL_S: string;
  PUBLISH_THRESHOLD: string;

  // --- Secrets ------------------------------------------------------------
  ADMIN_TOKEN?: string;
  IPFS_API_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ANTHROPIC_API_KEY?: string;
}

export type Job =
  | { type: 'crawl'; siteId: string; reason: 'scheduled' | 'manual' | 'retry'; attempt?: number }
  | { type: 'artifact'; snapshotId: string }
  | { type: 'analyze'; changeId: string }
  | { type: 'notify'; changeId: string }
  | { type: 'digest'; day: string };

export const CHANGE_TYPES = [
  'CONTENT',
  'TEXT',
  'PRICE',
  'LINK',
  'IMAGE',
  'STRUCTURE',
  'METADATA',
  'TITLE',
  'STATUS_CODE',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const SEVERITIES = ['TRIVIAL', 'MINOR', 'MODERATE', 'SIGNIFICANT', 'MAJOR'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'Pricing',
  'AI',
  'SaaS',
  'Startups',
  'Open Source',
  'APIs',
  'Security',
  'Products',
  'Documentation',
  'Companies',
  'Weird Internet',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type SiteStatus = 'ACTIVE' | 'PAUSED' | 'ERROR' | 'ARCHIVED';

export interface MonitoredSite {
  id: string;
  /** Readable URL key; null until assigned (the id works meanwhile). */
  slug: string | null;
  url: string;
  canonical_url: string;
  host: string;
  title: string | null;
  description: string | null;
  category: string;
  status: SiteStatus;
  crawl_interval_s: number;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  render_mode: 'AUTO' | 'HTTP' | 'BROWSER';
  normalization: string | null;
  robots_allowed: number;
  consecutive_errors: number;
  next_check_at: number;
  last_checked_at: number | null;
  last_changed_at: number | null;
  last_status: number | null;
  last_error: string | null;
  snapshot_count: number;
  change_count: number;
  created_at: number;
  updated_at: number;
}

export interface Snapshot {
  id: string;
  site_id: string;
  captured_at: number;
  http_status: number | null;
  content_type: string | null;
  final_url: string | null;
  fetch_method: string;
  fetch_ms: number | null;
  raw_bytes: number | null;
  content_hash: string;
  raw_hash: string | null;
  cid: string | null;
  page_cid: string | null;
  text_cid: string | null;
  raw_storage_ref: string | null;
  normalized_content: string | null;
  text_content: string | null;
  title: string | null;
  headers: string | null;
  previous_snapshot_id: string | null;
  is_duplicate: number;
  created_at: number;
}

export interface ChangeEvent {
  id: string;
  slug: string;
  site_id: string;
  previous_snapshot_id: string | null;
  current_snapshot_id: string;
  detected_at: number;
  change_type: ChangeType;
  severity: Severity;
  change_score: number;
  interestingness_score: number;
  headline: string;
  summary: string;
  label: string | null;
  before_value: string | null;
  after_value: string | null;
  delta: string | null;
  delta_note: string | null;
  diff: string;
  signals: string | null;
  suppressed: string | null;
  ai_model: string | null;
  ai_analysis: string | null;
  published: number;
  false_positive: number;
  views: number;
  shares: number;
  created_at: number;
}

/** Crawl interval presets. Users pick a preset, never an arbitrary rate. */
export const INTERVAL_PRESETS: Record<string, number> = {
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '6h': 21600,
  '12h': 43200,
  '24h': 86400,
};

/** Floor on crawl frequency, regardless of what a client asks for. */
export const MIN_CRAWL_INTERVAL_S = 900;
