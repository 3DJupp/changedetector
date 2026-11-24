/**
 * In-memory stand-ins for the Worker bindings, so route handlers can be tested
 * against the real migrations and real SQL. D1 is emulated with node:sqlite
 * (same engine, FTS5 included), KV with a Map.
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../src/types';

const require = createRequire(import.meta.url);
// Loaded at runtime: the bundler does not know the node:sqlite builtin yet.
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type Value = string | number | null | bigint | Uint8Array;

function normalize(values: unknown[]): Value[] {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value as Value;
  });
}

class FakeStatement {
  constructor(
    private readonly db: InstanceType<typeof DatabaseSync>,
    readonly sql: string,
    private readonly values: Value[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, normalize(values));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results: rows.map((row) => ({ ...row })) as T[], success: true, meta: {} };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export class FakeD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    const dir = join(import.meta.dirname, '..', '..', 'migrations');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(join(dir, file), 'utf8'));
    }
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }

  async batch(statements: FakeStatement[]) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  rows<T = Record<string, unknown>>(sql: string, ...values: unknown[]): T[] {
    return (this.sqlite.prepare(sql).all(...normalize(values)) as T[]).map((row) => ({ ...row }) as T);
  }
}

export class FakeKV {
  readonly store = new Map<string, string>();
  async get(key: string, type?: string) {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

export function testEnv(overrides: Partial<Env> = {}): Env & { DB: FakeD1 } {
  return {
    DB: new FakeD1(),
    CACHE: new FakeKV(),
    PUBLIC_BASE_URL: 'https://changes.example',
    TOOL_VERSION: 'test',
    USER_AGENT: 'TestBot/1.0',
    CONTENT_STORE: 'r2',
    IPFS_GATEWAY: 'https://ipfs.io/ipfs',
    IPFS_API_URL: '',
    AI_MODEL: '',
    AI_EMBEDDING_MODEL: '',
    MAX_RESPONSE_BYTES: '2097152',
    FETCH_TIMEOUT_MS: '15000',
    DOMAIN_MIN_INTERVAL_S: '20',
    PUBLISH_THRESHOLD: '25',
    ADMIN_TOKEN: 'test-admin',
    ...overrides,
  } as unknown as Env & { DB: FakeD1 };
}

export const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    promise.catch(() => undefined);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
