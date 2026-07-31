import type { BuildId } from '../hash/build-id.js';
import type { BuildState } from '../schemas/build.js';

/**
 * Storage ports. Every implementation, local or remote, satisfies these and is held to
 * the same contract suite. Keeping them in `core` is what lets `runtime` depend on
 * behaviour rather than on node:sqlite or a Cloudflare binding.
 */

export interface BuildSummary {
  readonly buildId: BuildId;
  readonly state: BuildState;
  readonly createdAt: string;
  readonly counts: {
    readonly artifacts: number;
    readonly nodes: number;
    readonly chunks: number;
    readonly tables: number;
    readonly tableRows: number;
  };
}

export interface CandidateBuild {
  readonly directory: string;
  readonly databasePath: string;
}

export interface BuildStore {
  createCandidate(): Promise<CandidateBuild>;
  seal(candidate: CandidateBuild, buildId: BuildId): Promise<BuildSummary>;
  discard(candidate: CandidateBuild): Promise<void>;
  listBuilds(): Promise<BuildSummary[]>;
  activate(buildId: BuildId): Promise<void>;
  current(): Promise<BuildSummary | null>;
}

/**
 * A read-only handle on one immutable build. Requests acquire one at their start and
 * release it at their end, so activation is observed at the next request boundary and no
 * single response can mix two builds.
 */
export interface BuildHandle {
  readonly buildId: BuildId;
  readonly generation: number;
  release(): void;
}

export interface ActiveBuildProvider {
  current(): Promise<{ buildId: BuildId; generation: number } | null>;
  acquire(): Promise<BuildHandle>;
}

export interface ObjectStore {
  get(hash: string): Promise<Uint8Array | null>;
  put(data: Uint8Array): Promise<string>;
  has(hash: string): Promise<boolean>;
}
