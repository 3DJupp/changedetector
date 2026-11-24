// The project compiles against the Workers runtime types only. These are the
// few Node APIs the test doubles use, declared narrowly instead of pulling in
// @types/node, whose globals clash with @cloudflare/workers-types.
declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown;
}
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:sqlite' {
  interface StatementSync {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
interface ImportMeta {
  url: string;
  dirname: string;
}
