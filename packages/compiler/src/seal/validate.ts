import type { DatabaseSync } from 'node:sqlite';
import { type Artifact, count, type LoreNode, type ObjectStore } from '@lorepack/core';
import type { Chunk } from '../chunk/chunk.js';

/**
 * The gate between a candidate and a build.
 *
 * Architecture section 12.10 lists what must hold before sealing. Each check is
 * independent and named, so a failure says which invariant broke and on which record
 * rather than "build failed". This is the mechanism behind "a failed build can never
 * corrupt the active version": nothing reaches `builds/` until every check passes.
 */

export type ValidationCheckName =
  | 'artifact-identity'
  | 'node-integrity'
  | 'chunk-integrity'
  | 'chunk-provenance'
  | 'fts-parity'
  | 'supersession-graph'
  | 'object-checksums'
  | 'no-secrets-in-manifest'
  | 'smoke-search'
  | 'smoke-source-read'
  | 'database-integrity';

export interface ValidationFailure {
  readonly check: ValidationCheckName;
  readonly message: string;
  /** The record that broke the invariant, so the failure is actionable. */
  readonly subject?: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly checksRun: readonly ValidationCheckName[];
  readonly failures: readonly ValidationFailure[];
}

export interface ValidationInput {
  readonly db: DatabaseSync;
  readonly objects: ObjectStore;
  readonly artifacts: readonly {
    readonly artifact: Artifact;
    readonly nodes: readonly LoreNode[];
    readonly chunks: readonly Chunk[];
    readonly objectHash: string;
  }[];
  readonly manifest: Readonly<Record<string, unknown>>;
  /** Values that must never appear in the manifest, from the environment. */
  readonly secrets?: readonly string[];
  readonly integrityCheck: (db: DatabaseSync) => { ok: boolean; problems: string[] };
  readonly search: (db: DatabaseSync, query: string, limit?: number) => unknown[];
  readonly countRows: (db: DatabaseSync, table: string) => number;
}

export async function validateCandidate(input: ValidationInput): Promise<ValidationReport> {
  const failures: ValidationFailure[] = [];
  const checksRun: ValidationCheckName[] = [];

  const run = (name: ValidationCheckName, check: () => ValidationFailure[]): void => {
    checksRun.push(name);
    failures.push(...check());
  };

  run('artifact-identity', () => checkArtifactIdentity(input));
  run('node-integrity', () => checkNodeIntegrity(input));
  run('chunk-integrity', () => checkChunkIntegrity(input));
  run('chunk-provenance', () => checkChunkProvenance(input));
  run('fts-parity', () => checkFtsParity(input));
  run('supersession-graph', () => checkSupersessionGraph(input));
  run('no-secrets-in-manifest', () => checkNoSecrets(input));
  run('database-integrity', () => checkDatabaseIntegrity(input));
  run('smoke-search', () => checkSmokeSearch(input));

  checksRun.push('object-checksums');
  failures.push(...(await checkObjectChecksums(input)));
  checksRun.push('smoke-source-read');
  failures.push(...(await checkSmokeSourceRead(input)));

  return { ok: failures.length === 0, checksRun, failures };
}

function checkArtifactIdentity(input: ValidationInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const seen = new Set<string>();
  for (const { artifact } of input.artifacts) {
    if (artifact.id === '') {
      failures.push({ check: 'artifact-identity', message: 'An artifact has an empty id.' });
      continue;
    }
    if (seen.has(artifact.id)) {
      failures.push({
        check: 'artifact-identity',
        message: 'Two artifacts share an id.',
        subject: artifact.id,
      });
    }
    seen.add(artifact.id);
    if (!/^[0-9a-f]{64}$/.test(artifact.contentHash)) {
      failures.push({
        check: 'artifact-identity',
        message: 'An artifact has no valid content hash.',
        subject: artifact.id,
      });
    }
  }
  return failures;
}

function checkNodeIntegrity(input: ValidationInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const entry of input.artifacts) {
    const ids = new Set(entry.nodes.map((node) => node.id));
    for (const node of entry.nodes) {
      if (node.artifactId !== entry.artifact.id) {
        failures.push({
          check: 'node-integrity',
          message: 'A node belongs to a different artifact than the one it was stored under.',
          subject: node.id,
        });
      }
      if (node.parentId !== undefined && !ids.has(node.parentId)) {
        failures.push({
          check: 'node-integrity',
          message: 'A node points at a parent that does not exist.',
          subject: node.id,
        });
      }
    }
  }
  return failures;
}

function checkChunkIntegrity(input: ValidationInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const entry of input.artifacts) {
    const nodeIds = new Set(entry.nodes.map((node) => node.id));
    for (const chunk of entry.chunks) {
      if (chunk.artifactId !== entry.artifact.id) {
        failures.push({
          check: 'chunk-integrity',
          message: 'A chunk belongs to a different artifact.',
          subject: chunk.id,
        });
      }
      if (chunk.nodeIds.length === 0) {
        failures.push({
          check: 'chunk-integrity',
          message: 'A chunk references no nodes.',
          subject: chunk.id,
        });
      }
      for (const nodeId of chunk.nodeIds) {
        if (!nodeIds.has(nodeId)) {
          failures.push({
            check: 'chunk-integrity',
            message: `A chunk references node ${nodeId}, which does not exist.`,
            subject: chunk.id,
          });
        }
      }
    }
  }
  return failures;
}

/** Provenance is mandatory (section 10.8): a chunk without a locator is invalid, not untidy. */
function checkChunkProvenance(input: ValidationInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const entry of input.artifacts) {
    for (const chunk of entry.chunks) {
      if (chunk.locator === undefined || chunk.locator.relativePath === '') {
        failures.push({
          check: 'chunk-provenance',
          message: 'A chunk has no source locator, so a result citing it could not be traced.',
          subject: chunk.id,
        });
      }
    }
  }
  return failures;
}

function checkFtsParity(input: ValidationInput): ValidationFailure[] {
  const chunks = input.countRows(input.db, 'chunks');
  const fts = input.countRows(input.db, 'chunks_fts');
  if (chunks === fts) return [];
  return [
    {
      check: 'fts-parity',
      message: `The lexical index holds ${count(fts, 'row')} for ${count(chunks, 'chunk')}, so some content would be unsearchable.`,
    },
  ];
}

function checkSupersessionGraph(input: ValidationInput): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const known = new Set(input.artifacts.map((entry) => entry.artifact.id));
  const edges = new Map<string, readonly string[]>();

  for (const { artifact } of input.artifacts) {
    edges.set(artifact.id, artifact.supersedes);
    for (const target of artifact.supersedes) {
      if (!known.has(target)) {
        failures.push({
          check: 'supersession-graph',
          message: `Supersedes an artifact that is not in this build: ${target}`,
          subject: artifact.id,
        });
      }
    }
  }

  // A cycle means two artifacts each claim to replace the other, which cannot be resolved
  // into a ranking and would make retrieval order arbitrary.
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, path: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      failures.push({
        check: 'supersession-graph',
        message: `Supersession cycle: ${[...path, id].join(' -> ')}`,
        subject: id,
      });
      return;
    }
    state.set(id, 'visiting');
    for (const next of edges.get(id) ?? []) {
      if (known.has(next)) walk(next, [...path, id]);
    }
    state.set(id, 'done');
  };
  for (const id of known) walk(id, []);

  return failures;
}

async function checkObjectChecksums(input: ValidationInput): Promise<ValidationFailure[]> {
  const failures: ValidationFailure[] = [];
  for (const entry of input.artifacts) {
    // A read verifies the digest, so a corrupt object throws rather than returning bytes.
    try {
      const bytes = await input.objects.get(entry.objectHash);
      if (bytes === null) {
        failures.push({
          check: 'object-checksums',
          message: 'The normalized body for this artifact is missing from the object store.',
          subject: entry.artifact.id,
        });
      }
    } catch (error) {
      failures.push({
        check: 'object-checksums',
        message: `The normalized body failed verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
        subject: entry.artifact.id,
      });
    }
  }
  return failures;
}

function checkNoSecrets(input: ValidationInput): ValidationFailure[] {
  const serialized = JSON.stringify(input.manifest);
  const failures: ValidationFailure[] = [];
  for (const secret of input.secrets ?? []) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      // The value itself is never echoed: reporting it would put the secret in a log.
      failures.push({
        check: 'no-secrets-in-manifest',
        message: 'A secret value from the environment appears in the manifest.',
      });
    }
  }
  return failures;
}

function checkDatabaseIntegrity(input: ValidationInput): ValidationFailure[] {
  const result = input.integrityCheck(input.db);
  if (result.ok) return [];
  return [
    {
      check: 'database-integrity',
      message: `The build database failed its integrity check: ${result.problems.join('; ')}`,
    },
  ];
}

/**
 * A smoke search proves the index answers at all. An empty build legitimately has nothing
 * to find, so the check only runs when there is content.
 */
function checkSmokeSearch(input: ValidationInput): ValidationFailure[] {
  const terms = searchableTerms(input);
  if (terms.length === 0) return [];

  // Any one of them answering proves the index is alive. Several are tried because a
  // single term can legitimately fail to match: it may be a stopword, or long enough to
  // pass the length filter and still be rare enough to sit in a chunk the limit excludes.
  // Failing a build on one unlucky word is a worse error than checking three.
  for (const term of terms) {
    if (input.search(input.db, term, 1).length > 0) return [];
  }

  return [
    {
      check: 'smoke-search',
      message: `No term taken from indexed content returned a result. Tried ${terms
        .map((term) => `"${term}"`)
        .join(', ')}. The lexical index is present but not answering.`,
    },
  ];
}

async function checkSmokeSourceRead(input: ValidationInput): Promise<ValidationFailure[]> {
  const first = input.artifacts[0];
  if (first === undefined) return [];
  const bytes = await input.objects.get(first.objectHash);
  if (bytes !== null && bytes.byteLength > 0) return [];
  return [
    {
      check: 'smoke-source-read',
      message: 'Reading the first artifact back from the object store produced nothing.',
      subject: first.artifact.id,
    },
  ];
}

/**
 * Terms the index genuinely holds, taken the way the index takes them.
 *
 * Splitting on whitespace and then stripping punctuation invents words that cannot exist.
 * `read-only` is one whitespace token, so stripping the hyphen produced `readonly`, while
 * FTS5's `unicode61` tokenizer splits on the hyphen and stores `read` and `only`. The
 * validator then failed the build for not finding a term it had made up, on a file whose
 * first line was ordinary English (#184).
 *
 * Splitting on the same character class the tokenizer splits on removes the possibility:
 * every candidate here is a token the index was built from.
 */
const HOW_FTS5_SPLITS = /[^\p{L}\p{N}]+/gu;
const SMOKE_TERM_ATTEMPTS = 3;

export function searchableTerms(input: ValidationInput): string[] {
  const terms: string[] = [];
  for (const entry of input.artifacts) {
    for (const chunk of entry.chunks) {
      for (const candidate of chunk.text.split(HOW_FTS5_SPLITS)) {
        if (candidate.length < 4) continue;
        if (terms.includes(candidate)) continue;
        terms.push(candidate);
        if (terms.length >= SMOKE_TERM_ATTEMPTS) return terms;
      }
    }
  }
  return terms;
}
