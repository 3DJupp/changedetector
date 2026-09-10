/**
 * R2-backed ContentStore.
 *
 * Bytes live in R2 but are addressed by the same CIDs IPFS would assign, so
 * this is a self-hosted replica of an IPFS-addressable artifact rather than a
 * parallel universe. The CAR archive of every artifact is kept alongside it,
 * which is what makes migration to (or replication into) any IPFS provider a
 * single upload.
 */
import { ContentStore, ArtifactResult, Metadata, packArtifact, PutResult } from './content-store';
import { DirEntry, encodeFile } from '../lib/cid';

const CONTENT_PREFIX = 'content/';
const DIR_PREFIX = 'dir/';
const CAR_PREFIX = 'car/';

interface DirManifest {
  cid: string;
  entries: { name: string; cid: string; size: number }[];
  metadata?: Metadata;
  createdAt: string;
}

export class R2ContentStore implements ContentStore {
  readonly name = 'r2';

  constructor(
    private readonly bucket: R2Bucket,
    private readonly gateway: string,
  ) {}

  async put(content: Uint8Array, metadata?: Metadata): Promise<PutResult> {
    const dag = await encodeFile(content);
    const key = CONTENT_PREFIX + dag.root.cid;
    const head = await this.bucket.head(key);
    if (!head) {
      await this.bucket.put(key, content as unknown as ArrayBuffer, {
        httpMetadata: { cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: sanitizeMetadata(metadata),
      });
    }
    return { cid: dag.root.cid, size: content.length };
  }

  async putDirectory(entries: DirEntry[], metadata?: Metadata): Promise<ArtifactResult> {
    const { dag, car } = await packArtifact(entries);

    await Promise.all(
      entries.map(async (entry) => {
        const manifestEntry = dag.entries.find((e) => e.name === entry.name)!;
        const key = CONTENT_PREFIX + manifestEntry.cid;
        if (!(await this.bucket.head(key))) {
          await this.bucket.put(key, entry.content as unknown as ArrayBuffer, {
            httpMetadata: {
              cacheControl: 'public, max-age=31536000, immutable',
              contentType: guessContentType(entry.name),
            },
          });
        }
      }),
    );

    const manifest: DirManifest = {
      cid: dag.cid,
      entries: dag.entries,
      metadata,
      createdAt: new Date().toISOString(),
    };
    await this.bucket.put(DIR_PREFIX + dag.cid, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
    });
    await this.bucket.put(CAR_PREFIX + dag.cid + '.car', car as unknown as ArrayBuffer, {
      httpMetadata: { contentType: 'application/vnd.ipld.car', cacheControl: 'public, max-age=31536000, immutable' },
    });

    return {
      cid: dag.cid,
      size: entries.reduce((total, entry) => total + entry.content.length, 0),
      entries: dag.entries,
      replicas: ['r2'],
    };
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(CONTENT_PREFIX + cid);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async getPath(cid: string, path: string): Promise<Uint8Array | null> {
    const manifest = await this.getManifest(cid);
    if (!manifest) return null;
    const entry = manifest.entries.find((e) => e.name === path.replace(/^\//, ''));
    if (!entry) return null;
    return this.get(entry.cid);
  }

  async getManifest(cid: string): Promise<DirManifest | null> {
    const object = await this.bucket.get(DIR_PREFIX + cid);
    if (!object) return null;
    return (await object.json()) as DirManifest;
  }

  async getCar(cid: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(CAR_PREFIX + cid + '.car');
    return object?.body ?? null;
  }

  async exists(cid: string): Promise<boolean> {
    const [content, dir] = await Promise.all([
      this.bucket.head(CONTENT_PREFIX + cid),
      this.bucket.head(DIR_PREFIX + cid),
    ]);
    return Boolean(content || dir);
  }

  gatewayUrl(cid: string, path?: string): string {
    return `${this.gateway.replace(/\/$/, '')}/${cid}${path ? '/' + path.replace(/^\//, '') : ''}`;
  }
}

function sanitizeMetadata(metadata?: Metadata): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    out[key.slice(0, 60)] = String(value).slice(0, 400);
  }
  return out;
}

export function guessContentType(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.car')) return 'application/vnd.ipld.car';
  return 'application/octet-stream';
}
