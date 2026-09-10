/**
 * Store factory and the tiered store used in production.
 *
 * R2 is the durable primary replica; IPFS pinning is best-effort redundancy.
 * We never claim that IPFS alone guarantees availability — the UI reports how
 * many replicas actually accepted the artifact.
 */
import { ContentStore, ArtifactResult, Metadata, PutResult } from './content-store';
import { R2ContentStore } from './r2-store';
import { IpfsHttpStore } from './ipfs-http-store';
import { DirEntry } from '../lib/cid';
import type { Env } from '../types';

export * from './content-store';
export { R2ContentStore } from './r2-store';
export { IpfsHttpStore } from './ipfs-http-store';

/**
 * Writes to the primary, then mirrors to any secondary. A secondary failure
 * degrades redundancy; it never fails the capture.
 */
export class TieredContentStore implements ContentStore {
  readonly name = 'tiered';

  constructor(
    private readonly primary: ContentStore,
    private readonly secondaries: ContentStore[] = [],
  ) {}

  async put(content: Uint8Array, metadata?: Metadata): Promise<PutResult> {
    const result = await this.primary.put(content, metadata);
    await Promise.allSettled(this.secondaries.map((store) => store.put(content, metadata)));
    return result;
  }

  async putDirectory(entries: DirEntry[], metadata?: Metadata): Promise<ArtifactResult> {
    const result = await this.primary.putDirectory(entries, metadata);
    const mirrored = await Promise.allSettled(
      this.secondaries.map(async (store) => {
        await store.putDirectory(entries, metadata);
        return store.name;
      }),
    );
    const replicas = [
      ...result.replicas,
      ...mirrored.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value),
    ];
    return { ...result, replicas };
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const local = await this.primary.get(cid);
    if (local) return local;
    for (const store of this.secondaries) {
      const remote = await store.get(cid).catch(() => null);
      if (remote) return remote;
    }
    return null;
  }

  async getPath(cid: string, path: string): Promise<Uint8Array | null> {
    const local = await this.primary.getPath(cid, path);
    if (local) return local;
    for (const store of this.secondaries) {
      const remote = await store.getPath(cid, path).catch(() => null);
      if (remote) return remote;
    }
    return null;
  }

  async exists(cid: string): Promise<boolean> {
    if (await this.primary.exists(cid)) return true;
    for (const store of this.secondaries) if (await store.exists(cid).catch(() => false)) return true;
    return false;
  }

  gatewayUrl(cid: string, path?: string): string {
    return this.primary.gatewayUrl(cid, path);
  }
}

export function createContentStore(env: Env): ContentStore {
  const gateway = env.IPFS_GATEWAY || 'https://ipfs.io/ipfs';
  const r2 = new R2ContentStore(env.ARTIFACTS, gateway);
  const secondaries: ContentStore[] = [];

  if (env.IPFS_API_URL) {
    secondaries.push(
      new IpfsHttpStore({ apiUrl: env.IPFS_API_URL, token: env.IPFS_API_TOKEN, gateway }),
    );
  }
  if (env.CONTENT_STORE === 'ipfs-http' && secondaries.length > 0) {
    // IPFS primary, R2 as the durable mirror.
    return new TieredContentStore(secondaries[0], [r2]);
  }
  return new TieredContentStore(r2, secondaries);
}

/** The R2 store, for routes that need CAR export or directory manifests. */
export function rawR2Store(env: Env): R2ContentStore {
  return new R2ContentStore(env.ARTIFACTS, env.IPFS_GATEWAY || 'https://ipfs.io/ipfs');
}
