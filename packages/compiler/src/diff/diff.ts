import type { BuildDiff, BuildId, DiffArtifactChange, DiffRuleChange } from '@lorepack/core';

/**
 * The build diff engine.
 *
 * Everything here is a pure function over two snapshots of canonical build records. It
 * never re-parses a source, which is what makes comparing two builds instant and what
 * makes a comparison still possible after the source directory is gone. Reading the
 * snapshots out of sealed databases is the caller's job; deciding what changed is this
 * module's, and keeping those apart is what makes the decision testable.
 */

export interface SnapshotArtifact {
  readonly id: string;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly status: string;
  readonly authority: number;
  readonly supersedes: readonly string[];
}

export interface SnapshotChunk {
  readonly id: string;
  readonly revisionHash: string;
}

export interface SnapshotTable {
  readonly tableId: string;
  readonly name: string;
  readonly rows: number;
  readonly columns: readonly string[];
}

export interface BuildSnapshot {
  readonly buildId: BuildId;
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly compilerVersion: string;
  readonly capabilities: readonly string[];
  readonly canonicalRoots: Readonly<Record<string, string>>;
  readonly artifacts: readonly SnapshotArtifact[];
  readonly chunks: readonly SnapshotChunk[];
  readonly tables: readonly SnapshotTable[];
}

export function diffBuilds(from: BuildSnapshot, to: BuildSnapshot): BuildDiff {
  const artifacts = diffArtifacts(from, to);
  const chunks = diffChunks(from, to);
  const rules = diffRules(from, to);
  const tables = diffTables(from, to);

  const identical =
    from.buildId === to.buildId ||
    (artifacts.changes.length === 0 &&
      rules.length === 0 &&
      tables.length === 0 &&
      chunks.added === 0 &&
      chunks.changed === 0 &&
      chunks.removed === 0);

  return {
    formatVersion: 1,
    from: from.buildId,
    to: to.buildId,
    identical,
    incompatibilities: incompatibilities(from, to),
    artifacts,
    rules,
    chunks,
    tables,
    capabilities: diffCapabilities(from, to),
    canonicalRoots: diffRoots(from, to),
  };
}

/**
 * A format or schema difference makes a record-level comparison unreliable, because the
 * two sides may not mean the same thing by the same column. Saying so is more useful than
 * a confident diff that is quietly wrong.
 */
function incompatibilities(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['incompatibilities'] {
  const found: { field: string; from: string; to: string }[] = [];
  if (from.formatVersion !== to.formatVersion) {
    found.push({
      field: 'formatVersion',
      from: String(from.formatVersion),
      to: String(to.formatVersion),
    });
  }
  if (from.schemaVersion !== to.schemaVersion) {
    found.push({
      field: 'schemaVersion',
      from: String(from.schemaVersion),
      to: String(to.schemaVersion),
    });
  }
  return found;
}

function diffArtifacts(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['artifacts'] {
  const before = new Map(from.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const after = new Map(to.artifacts.map((artifact) => [artifact.relativePath, artifact]));

  // Content hash to path, used only to annotate a pair. A pure rename is still reported as
  // a removal and an addition: claiming to have detected a move would be inventing intent.
  const removedByHash = new Map<string, string>();
  for (const [path, artifact] of before) {
    if (!after.has(path)) removedByHash.set(artifact.contentHash, path);
  }
  const addedByHash = new Map<string, string>();
  for (const [path, artifact] of after) {
    if (!before.has(path)) addedByHash.set(artifact.contentHash, path);
  }

  const changes: DiffArtifactChange[] = [];
  for (const [path, artifact] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      const twin = removedByHash.get(artifact.contentHash);
      changes.push({
        path,
        change: 'added',
        ...(twin === undefined ? {} : { sameContentAs: twin }),
      });
    } else if (previous.contentHash !== artifact.contentHash) {
      changes.push({ path, change: 'changed' });
    }
  }
  for (const [path, artifact] of before) {
    if (after.has(path)) continue;
    const twin = addedByHash.get(artifact.contentHash);
    changes.push({
      path,
      change: 'removed',
      ...(twin === undefined ? {} : { sameContentAs: twin }),
    });
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    added: changes.filter((change) => change.change === 'added').length,
    changed: changes.filter((change) => change.change === 'changed').length,
    removed: changes.filter((change) => change.change === 'removed').length,
    changes,
  };
}

function diffChunks(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['chunks'] {
  const before = new Map(from.chunks.map((chunk) => [chunk.id, chunk.revisionHash]));
  const after = new Map(to.chunks.map((chunk) => [chunk.id, chunk.revisionHash]));

  let added = 0;
  let changed = 0;
  for (const [id, revision] of after) {
    const previous = before.get(id);
    if (previous === undefined) added += 1;
    else if (previous !== revision) changed += 1;
  }
  const removed = [...before.keys()].filter((id) => !after.has(id)).length;
  return { added, changed, removed };
}

/**
 * Rule changes are the declared ranking hints: status, authority and supersession. They
 * are user-declared, never inferred, so a diff reports the declaration moving and makes no
 * claim about which side is correct.
 */
function diffRules(from: BuildSnapshot, to: BuildSnapshot): DiffRuleChange[] {
  const before = new Map(from.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const changes: DiffRuleChange[] = [];

  for (const artifact of to.artifacts) {
    const previous = before.get(artifact.relativePath);
    if (previous === undefined) continue;

    if (previous.status !== artifact.status) {
      changes.push({
        path: artifact.relativePath,
        field: 'status',
        from: previous.status,
        to: artifact.status,
      });
    }
    if (previous.authority !== artifact.authority) {
      changes.push({
        path: artifact.relativePath,
        field: 'authority',
        from: String(previous.authority),
        to: String(artifact.authority),
      });
    }
    const supersededBefore = [...previous.supersedes].sort().join(', ');
    const supersededAfter = [...artifact.supersedes].sort().join(', ');
    if (supersededBefore !== supersededAfter) {
      changes.push({
        path: artifact.relativePath,
        field: 'supersedes',
        from: supersededBefore === '' ? null : supersededBefore,
        to: supersededAfter === '' ? null : supersededAfter,
      });
    }
  }

  return changes.sort((a, b) =>
    a.path === b.path ? (a.field < b.field ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
}

function diffTables(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['tables'] {
  const before = new Map(from.tables.map((table) => [table.tableId, table]));
  const after = new Map(to.tables.map((table) => [table.tableId, table]));
  const changes: BuildDiff['tables'] = [];

  for (const [id, table] of after) {
    const previous = before.get(id);
    const columnsBefore = new Set(previous?.columns ?? []);
    const columnsAfter = new Set(table.columns);
    const columnsAdded = [...columnsAfter].filter((column) => !columnsBefore.has(column)).sort();
    const columnsRemoved = [...columnsBefore].filter((column) => !columnsAfter.has(column)).sort();
    if (
      previous !== undefined &&
      previous.rows === table.rows &&
      columnsAdded.length === 0 &&
      columnsRemoved.length === 0
    ) {
      continue;
    }
    changes.push({
      tableId: id,
      name: table.name,
      rowsBefore: previous?.rows ?? null,
      rowsAfter: table.rows,
      columnsAdded,
      columnsRemoved,
    });
  }

  for (const [id, table] of before) {
    if (after.has(id)) continue;
    changes.push({
      tableId: id,
      name: table.name,
      rowsBefore: table.rows,
      rowsAfter: null,
      columnsAdded: [],
      columnsRemoved: [...table.columns].sort(),
    });
  }

  return changes.sort((a, b) => (a.tableId < b.tableId ? -1 : 1));
}

function diffCapabilities(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['capabilities'] {
  const before = new Set(from.capabilities);
  const after = new Set(to.capabilities);
  const names = [...new Set([...before, ...after])].sort();
  return names.map((capability) => ({
    capability: capability as BuildDiff['capabilities'][number]['capability'],
    change: before.has(capability)
      ? after.has(capability)
        ? ('same' as const)
        : ('removed' as const)
      : ('added' as const),
  }));
}

function diffRoots(from: BuildSnapshot, to: BuildSnapshot): BuildDiff['canonicalRoots'] {
  const names = [
    ...new Set([...Object.keys(from.canonicalRoots), ...Object.keys(to.canonicalRoots)]),
  ].sort();
  const zero = '0'.repeat(64);
  return names.map((root) => {
    const before = from.canonicalRoots[root] ?? zero;
    const after = to.canonicalRoots[root] ?? zero;
    return { root, from: before, to: after, changed: before !== after };
  });
}

/** The rendering from architecture section 18.3. */
export function renderDiff(diff: BuildDiff): string {
  const lines: string[] = [`Build ${diff.from.slice(0, 17)} -> ${diff.to.slice(0, 17)}`, ''];

  if (diff.incompatibilities.length > 0) {
    lines.push('Incompatible builds');
    for (const problem of diff.incompatibilities) {
      lines.push(`  ${problem.field} ${problem.from} -> ${problem.to}`);
    }
    lines.push('  Record-level comparison across this change may be misleading.', '');
  }

  if (diff.identical) {
    lines.push('No differences.');
    return lines.join('\n');
  }

  lines.push('Artifacts');
  if (diff.artifacts.changes.length === 0) lines.push('  none');
  for (const change of diff.artifacts.changes) {
    const marker = change.change === 'added' ? '+' : change.change === 'changed' ? '~' : '-';
    const note =
      change.sameContentAs === undefined ? '' : ` (same content as ${change.sameContentAs})`;
    lines.push(`  ${marker} ${change.path}${note}`);
  }

  lines.push('', 'Rules');
  if (diff.rules.length === 0) lines.push('  none');
  for (const rule of diff.rules) {
    lines.push(`  ~ ${rule.path} ${rule.field} ${rule.from ?? 'none'} -> ${rule.to ?? 'none'}`);
  }

  lines.push('', 'Context');
  lines.push(`  + ${diff.chunks.added} chunks`);
  lines.push(`  ~ ${diff.chunks.changed} chunks`);
  lines.push(`  - ${diff.chunks.removed} chunks`);

  lines.push('', 'Tables');
  if (diff.tables.length === 0) lines.push('  none');
  for (const table of diff.tables) {
    lines.push(`  ~ ${table.name}`);
    lines.push(`    rows ${table.rowsBefore ?? 'none'} -> ${table.rowsAfter ?? 'none'}`);
    if (table.columnsAdded.length > 0) {
      lines.push(`    columns + ${table.columnsAdded.join(', ')}`);
    }
    if (table.columnsRemoved.length > 0) {
      lines.push(`    columns - ${table.columnsRemoved.join(', ')}`);
    }
  }

  lines.push('', 'Capabilities');
  for (const capability of diff.capabilities) {
    const marker = capability.change === 'same' ? '=' : capability.change === 'added' ? '+' : '-';
    lines.push(`  ${marker} ${capability.capability}`);
  }

  return lines.join('\n');
}
