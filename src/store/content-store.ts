/**
 * ContentStore — the storage abstraction.
 *
 * The application never talks to a specific IPFS provider. It talks to this
 * interface, addresses everything by CID, and treats the provider as a
 * replaceable replica. Because CIDs are computed locally from the bytes, an
 * artifact keeps its identity no matter where the bytes happen to live.
 */
import { DirEntry, encodeDirectory, encodeFile, writeCar } from '../lib/cid';

export type Metadata = Record<string, string | number | boolean | null | undefined>;

export interface PutResult {
  cid: string;
  size: number;
}

export interface ArtifactResult extends PutResult {
  /** Per-file CIDs inside the artifact directory. */
  entries: { name: string; cid: string; size: number }[];
  /** Providers that accepted the bytes, e.g. ["r2", "ipfs"]. */
  replicas: string[];
}

export interface ContentStore {
  readonly name: string;
  put(content: Uint8Array, metadata?: Metadata): Promise<PutResult>;
  putDirectory(entries: DirEntry[], metadata?: Metadata): Promise<ArtifactResult>;
  get(cid: string): Promise<Uint8Array | null>;
  getPath(cid: string, path: string): Promise<Uint8Array | null>;
  exists(cid: string): Promise<boolean>;
  /** Public gateway URL for humans. Never used as the canonical reference. */
  gatewayUrl(cid: string, path?: string): string;
}

/** Shared helper: compute CIDs and the CAR archive for an artifact directory. */
export async function packArtifact(entries: DirEntry[]) {
  const dag = await encodeDirectory(entries);
  const car = writeCar(dag.root, dag.blocks);
  return { dag, car };
}

export async function fileCid(content: Uint8Array): Promise<string> {
  const dag = await encodeFile(content);
  return dag.root.cid;
}
