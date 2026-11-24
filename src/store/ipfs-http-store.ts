/**
 * IPFS ContentStore over the HTTP API.
 *
 * Works with anything that speaks the Kubo RPC surface (a self-hosted node,
 * ipfs-cluster, or a hosted provider that proxies it). Artifacts are pushed as
 * a CAR archive, which is the provider-neutral interchange format — nothing
 * here is specific to one vendor.
 */
import { ContentStore, ArtifactResult, Metadata, packArtifact, PutResult } from './content-store';
import { DirEntry, encodeFile } from '../lib/cid';

export interface IpfsStoreOptions {
  apiUrl: string;
  token?: string;
  gateway: string;
  timeoutMs?: number;
}

export class IpfsHttpStore implements ContentStore {
  readonly name = 'ipfs';

  constructor(private readonly options: IpfsStoreOptions) {}

  private headers(): HeadersInit {
    return this.options.token ? { authorization: `Bearer ${this.options.token}` } : {};
  }

  private async rpc(path: string, body: FormData, query = ''): Promise<Response> {
    const url = `${this.options.apiUrl.replace(/\/$/, '')}/api/v0/${path}${query}`;
    return fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
    });
  }

  async put(content: Uint8Array, _metadata?: Metadata): Promise<PutResult> {
    const dag = await encodeFile(content);
    const form = new FormData();
    form.append('file', new Blob([content as unknown as ArrayBuffer]), 'blob');
    const response = await this.rpc('add', form, '?cid-version=1&raw-leaves=true&pin=true');
    if (!response.ok) throw new Error(`IPFS add failed: ${response.status} ${await safeText(response)}`);
    const parsed = (await response.json()) as { Hash?: string };
    // The locally computed CID is authoritative; a mismatch means the remote
    // node chunked differently and we must not publish its answer as ours.
    if (parsed.Hash && parsed.Hash !== dag.root.cid) {
      throw new Error(`CID mismatch: local ${dag.root.cid}, remote ${parsed.Hash}`);
    }
    return { cid: dag.root.cid, size: content.length };
  }

  async putDirectory(entries: DirEntry[], _metadata?: Metadata): Promise<ArtifactResult> {
    const { dag, car } = await packArtifact(entries);
    const form = new FormData();
    form.append('file', new Blob([car as unknown as ArrayBuffer], { type: 'application/vnd.ipld.car' }), 'artifact.car');
    const response = await this.rpc('dag/import', form, '?pin-roots=true');
    if (!response.ok) throw new Error(`IPFS dag/import failed: ${response.status} ${await safeText(response)}`);
    return {
      cid: dag.cid,
      size: entries.reduce((total, entry) => total + entry.content.length, 0),
      entries: dag.entries,
      replicas: ['ipfs'],
    };
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const response = await fetch(this.gatewayUrl(cid), { signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000) });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async getPath(cid: string, path: string): Promise<Uint8Array | null> {
    const response = await fetch(this.gatewayUrl(cid, path), {
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
    });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async exists(cid: string): Promise<boolean> {
    try {
      const response = await this.rpc('block/stat', new FormData(), `?arg=${encodeURIComponent(cid)}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  gatewayUrl(cid: string, path?: string): string {
    return `${this.options.gateway.replace(/\/$/, '')}/${cid}${path ? '/' + path.replace(/^\//, '') : ''}`;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}
