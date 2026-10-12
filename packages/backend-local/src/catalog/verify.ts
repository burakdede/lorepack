import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BuildIdInputs,
  type BuildManifest,
  CANONICALIZATION_VERSION,
  type Canonical,
  canonicalize,
  deriveBuildId,
  hashBytes,
  hashCanonical,
  hashRoot,
  LoreError,
  type LoreNode,
  locatorBounds,
  locatorProblem,
  NORMALIZATION_VERSION,
  type ParsedArtifact,
  SCHEMA_VERSION,
  type SourceLocator,
  sha256Schema,
} from '@lorepack/core';
import { assertMigrationsKnown, loadMigrations, runMigrations } from '../migrations.js';
import { buildMigrationsDirectory } from '../migrations-path.js';
import { openWritable } from '../sqlite.js';
import { assertIdentifier } from './tables.js';

export interface LogicalCatalogProof {
  readonly buildId: string;
  readonly objectHashes: readonly string[];
  readonly canonicalRoots: BuildManifest['canonicalRoots'];
}

function requireValid(condition: boolean, subject: string, message: string): void {
  if (!condition) {
    throw new LoreError('LORE_E_OBJECT_CORRUPT', message, {
      remediation:
        'Restore or rebuild the package. Regenerating checksums does not repair its content.',
      subject,
    });
  }
}

interface ArtifactRow {
  id: string;
  content_hash: string;
  object_hash: string;
  status: string;
  authority: number;
}
interface NodeRow {
  id: string;
  artifact_id: string;
  parent_id: string | null;
  kind: string;
  title: string | null;
  text: string | null;
  revision_hash: string;
}
interface ChunkRow {
  id: string;
  artifact_id: string;
  node_ids: string;
  text: string;
  revision_hash: string;
}
interface TableRow {
  id: string;
  artifact_id: string;
  sql_name: string;
  row_count: number;
}
interface ColumnRow {
  ordinal: number;
  name: string;
  sql_name: string;
  type: string;
  nullable: number;
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${assertIdentifier(table)}`).get();
  return Number(row?.n);
}

function verifyFtsIndex(db: DatabaseSync, referencePath: string): void {
  const reference = openWritable(referencePath);
  try {
    runMigrations(reference, loadMigrations(buildMigrationsDirectory()));
    const insert = reference.prepare(`INSERT INTO chunks_fts
      (rowid, chunk_id, artifact_id, status, authority, path, title, heading, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    reference.exec('BEGIN');
    for (const row of db
      .prepare(`SELECT rowid, chunk_id, artifact_id, status, authority,
      path, title, heading, body FROM chunks_fts`)
      .iterate()) {
      const values = [
        'rowid',
        'chunk_id',
        'artifact_id',
        'status',
        'authority',
        'path',
        'title',
        'heading',
        'body',
      ].map((key) => {
        const value = row[key];
        if (value === undefined) throw new Error('Missing FTS projection column.');
        return value;
      });
      insert.run(...values);
    }
    reference.exec('COMMIT');
    const vocabulary =
      "CREATE VIRTUAL TABLE temp.verification_vocab USING fts5vocab(main, chunks_fts, 'instance')";
    db.exec(vocabulary);
    reference.exec(vocabulary);
    const select =
      'SELECT term, doc, col, offset FROM temp.verification_vocab ORDER BY term, doc, col, offset';
    const actual = db.prepare(select).iterate();
    const expected = reference.prepare(select).iterate();
    try {
      while (true) {
        const left = actual.next();
        const right = expected.next();
        requireValid(
          left.done === right.done && JSON.stringify(left.value) === JSON.stringify(right.value),
          'context.sqlite',
          'The FTS term index disagrees with its canonical projection.',
        );
        if (left.done) break;
      }
    } finally {
      actual.return?.();
      expected.return?.();
    }
    const sizes = db.prepare('SELECT id, sz FROM chunks_fts_docsize ORDER BY id').iterate();
    const expectedSizes = reference
      .prepare('SELECT id, sz FROM chunks_fts_docsize ORDER BY id')
      .iterate();
    try {
      while (true) {
        const left = sizes.next();
        const right = expectedSizes.next();
        requireValid(
          left.done === right.done && JSON.stringify(left.value) === JSON.stringify(right.value),
          'context.sqlite',
          'FTS document sizes disagree with the canonical projection.',
        );
        if (left.done) break;
      }
    } finally {
      sizes.return?.();
      expectedSizes.return?.();
    }
  } finally {
    reference.close();
  }
}

export function verifyLogicalCatalog(
  db: DatabaseSync,
  manifest: BuildManifest,
  inputs: BuildIdInputs,
  referencePath: string,
): LogicalCatalogProof {
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    inputs.schemaVersion !== SCHEMA_VERSION ||
    inputs.canonicalizationVersion !== CANONICALIZATION_VERSION ||
    inputs.normalizationVersion !== NORMALIZATION_VERSION
  ) {
    throw new LoreError(
      'LORE_E_SCHEMA_MISMATCH',
      'The package uses an unsupported catalog or hashing version.',
      {
        remediation: 'Use a Lorepack version that supports the recorded identity inputs.',
        subject: 'reports/build-id-inputs.json',
      },
    );
  }
  requireValid(
    inputs.compilerVersion === manifest.compilerVersion &&
      inputs.formatVersion === manifest.formatVersion,
    'manifest.json',
    'Manifest versions disagree with the identity inputs.',
  );
  requireValid(
    hashCanonical(inputs.effectiveConfig) === manifest.configurationHash,
    'manifest.json',
    'Effective configuration does not match its recorded hash.',
  );
  requireValid(
    hashCanonical(inputs.embeddingProfile) ===
      hashCanonical((manifest.embeddingProfile ?? null) as Canonical),
    'manifest.json',
    'Embedding identity disagrees with the recorded inputs.',
  );

  const schema = db.prepare('SELECT name, type, sql FROM sqlite_schema').all();
  requireValid(
    !schema.some((row) => row.type === 'view' || row.type === 'trigger'),
    'context.sqlite',
    'A build catalog may not contain views or triggers.',
  );
  const fts = schema.find((row) => row.name === 'chunks_fts');
  requireValid(
    typeof fts?.sql === 'string' && /CREATE\s+VIRTUAL\s+TABLE[\s\S]*USING\s+fts5\b/i.test(fts.sql),
    'context.sqlite',
    'The catalog does not contain the expected FTS5 projection.',
  );
  requireValid(
    !schema.some(
      (row) =>
        typeof row.sql === 'string' &&
        /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql) &&
        row.name !== 'chunks_fts',
    ),
    'context.sqlite',
    'The catalog contains an unsupported virtual table.',
  );
  const migrations = loadMigrations(buildMigrationsDirectory());
  assertMigrationsKnown(db, migrations);
  const applied = db.prepare('SELECT id, name, checksum FROM schema_migrations ORDER BY id').all();
  requireValid(
    applied.length === migrations.length &&
      migrations.every((migration, index) => {
        const row = applied[index];
        return (
          row?.id === migration.id &&
          row.name === migration.name &&
          row.checksum === migration.checksum
        );
      }),
    'context.sqlite',
    'The catalog does not record the complete, unchanged build migrations.',
  );
  const reference = openWritable(':memory:');
  const expectedNames = new Set<string>();
  try {
    runMigrations(reference, migrations);
    for (const expected of reference.prepare('SELECT name, type, sql FROM sqlite_schema').all()) {
      const actual = schema.find((row) => row.name === expected.name);
      requireValid(
        actual?.type === expected.type && actual?.sql === expected.sql,
        'context.sqlite',
        'A catalog schema definition differs from the supported build schema.',
      );
      expectedNames.add(String(expected.name));
    }
  } finally {
    reference.close();
  }
  const integrity = db.prepare('PRAGMA integrity_check').all();
  requireValid(
    integrity.length === 1 && Object.values(integrity[0] ?? {})[0] === 'ok',
    'context.sqlite',
    'The catalog failed SQLite integrity checking.',
  );
  requireValid(
    db.prepare('PRAGMA foreign_key_check').all().length === 0,
    'context.sqlite',
    'The catalog contains broken foreign-key references.',
  );
  verifyLocatorRanges(db);

  const artifacts = db
    .prepare('SELECT id, content_hash, object_hash, status, authority FROM artifacts ORDER BY id')
    .all() as unknown as ArtifactRow[];
  const tables = db
    .prepare('SELECT id, artifact_id, sql_name, row_count FROM tables ORDER BY id')
    .all() as unknown as TableRow[];
  const artifactIds = new Set(artifacts.map((row) => row.id));
  const nodeById = new Map(
    db
      .prepare('SELECT id, artifact_id FROM nodes')
      .all()
      .map((row) => [String(row.id), String(row.artifact_id)]),
  );
  const nodeHashes: string[] = [];
  const chunkHashes: string[] = [];
  for (const row of artifacts) {
    requireValid(
      sha256Schema.safeParse(row.content_hash).success &&
        sha256Schema.safeParse(row.object_hash).success,
      row.id,
      'An artifact contains an invalid content or object digest.',
    );
  }
  const rules = artifacts
    .map((row) => {
      const supersedes = db
        .prepare(
          'SELECT superseded_id FROM supersessions WHERE artifact_id = ? ORDER BY superseded_id',
        )
        .all(row.id)
        .map((entry) => String(entry.superseded_id));
      requireValid(
        ['active', 'draft', 'archived'].includes(row.status) &&
          Number.isInteger(row.authority) &&
          row.authority >= 0 &&
          row.authority <= 100 &&
          supersedes.every((id) => artifactIds.has(id) && id !== row.id),
        row.id,
        'An artifact contains invalid declared ranking hints.',
      );
      return [row.id, row.status, row.authority, supersedes] as const;
    })
    .filter((row) => row[1] !== 'active' || row[2] !== 50 || row[3].length > 0);
  requireValid(
    hashCanonical(rules as unknown as Canonical) === hashCanonical(inputs.ruleResolution),
    'context.sqlite',
    'Declared ranking hints disagree with the canonical rule inputs.',
  );
  for (const entry of db
    .prepare('SELECT id, artifact_id, parent_id, kind, title, text, revision_hash FROM nodes')
    .iterate()) {
    const row = entry as unknown as NodeRow;
    requireValid(
      artifactIds.has(row.artifact_id) &&
        (row.parent_id === null || nodeById.get(row.parent_id) === row.artifact_id),
      row.id,
      'A node references an absent artifact or parent.',
    );
    const original = hashBytes(`${row.kind}\0${row.title ?? ''}\0${row.text ?? ''}`);
    // Normalization v1 rehashes changed text with spaces; untouched parser nodes retain NUL separators.
    const normalized =
      row.text === null ? original : hashBytes(`${row.kind} ${row.title ?? ''} ${row.text}`);
    requireValid(
      row.revision_hash === original || row.revision_hash === normalized,
      row.id,
      'Node content disagrees with its revision hash.',
    );
    nodeHashes.push(row.revision_hash);
  }
  for (const entry of db
    .prepare('SELECT id, artifact_id, node_ids, text, revision_hash FROM chunks')
    .iterate()) {
    const row = entry as unknown as ChunkRow;
    const nodeIds: unknown = JSON.parse(row.node_ids);
    requireValid(
      artifactIds.has(row.artifact_id) &&
        Array.isArray(nodeIds) &&
        nodeIds.length > 0 &&
        nodeIds.every((id) => typeof id === 'string' && nodeById.get(id) === row.artifact_id),
      row.id,
      'A chunk references an absent artifact or node.',
    );
    requireValid(
      typeof row.text === 'string' && hashBytes(row.text) === row.revision_hash,
      row.id,
      'Chunk content disagrees with its revision hash.',
    );
    chunkHashes.push(row.revision_hash);
  }

  const mismatch = db
    .prepare(`SELECT count(*) AS n FROM chunks c
    JOIN artifacts a ON a.id = c.artifact_id
    LEFT JOIN chunks_fts f ON f.chunk_id = c.id
    WHERE f.chunk_id IS NULL OR f.artifact_id IS NOT a.id OR f.status IS NOT a.status
      OR CAST(f.authority AS INTEGER) IS NOT a.authority OR f.path IS NOT c.relative_path
      OR f.title IS NOT coalesce(a.title, '') OR f.body IS NOT c.text
      OR f.heading IS NOT (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(c.heading_path))`)
    .get();
  requireValid(
    Number(mismatch?.n) === 0 && countRows(db, 'chunks_fts') === chunkHashes.length,
    'context.sqlite',
    'FTS rows disagree with their canonical chunks and artifact metadata.',
  );
  verifyFtsIndex(db, referencePath);

  const tableHashes: string[] = [];
  let tableRows = 0;
  for (const table of tables) {
    requireValid(
      artifactIds.has(table.artifact_id),
      table.id,
      'A table references an absent artifact.',
    );
    const columns = db
      .prepare(
        'SELECT ordinal, name, sql_name, type, nullable FROM table_columns WHERE table_id = ? ORDER BY ordinal',
      )
      .all(table.id) as unknown as ColumnRow[];
    const physical = assertIdentifier(table.sql_name);
    const rows = countRows(db, physical);
    requireValid(
      rows === table.row_count &&
        columns.length > 0 &&
        columns.every(
          (column, index) =>
            column.ordinal === index &&
            (column.nullable === 0 || column.nullable === 1) &&
            ['text', 'date', 'unknown', 'integer', 'real', 'boolean'].includes(column.type),
        ),
      table.id,
      'A typed table has inconsistent row count or column ordering.',
    );
    const storageTypes: Record<string, string> = {
      text: 'TEXT',
      date: 'TEXT',
      unknown: 'TEXT',
      integer: 'INTEGER',
      real: 'REAL',
      boolean: 'INTEGER',
    };
    const definition = columns
      .map((column) => `${assertIdentifier(column.sql_name)} ${storageTypes[column.type]}`)
      .join(', ');
    const physicalSchema = schema.find((row) => row.name === physical);
    requireValid(
      physical.startsWith('t_') &&
        physicalSchema?.type === 'table' &&
        physicalSchema.sql === `CREATE TABLE ${physical} (${definition}) STRICT`,
      table.id,
      'A typed table has an unsupported physical schema.',
    );
    expectedNames.add(physical);
    const columnDefinition = columns.map((column) => [
      column.name,
      column.type,
      column.nullable === 1,
    ]);
    const hash = createHash('sha256');
    hash.update(
      `a3:${canonicalize(table.id)}${canonicalize(columnDefinition as Canonical)}a${rows}:`,
    );
    const sql = `SELECT ${columns.map((column) => assertIdentifier(column.sql_name)).join(', ')} FROM ${physical} ORDER BY rowid`;
    for (const row of db.prepare(sql).iterate()) {
      const values = columns.map((column) => {
        const value = row[column.sql_name];
        requireValid(
          value !== undefined && (value !== null || column.nullable === 1),
          table.id,
          'A cell violates its column definition.',
        );
        if (value === null) return null;
        if (column.type === 'boolean') {
          requireValid(value === 0 || value === 1, table.id, 'A boolean cell is not zero or one.');
          return value === 1;
        }
        if (column.type === 'integer' || column.type === 'real') {
          requireValid(
            typeof value === 'number' &&
              Number.isFinite(value) &&
              (column.type !== 'integer' || Number.isSafeInteger(value)),
            table.id,
            'A numeric cell cannot be represented by its declared type.',
          );
        } else {
          requireValid(
            ['text', 'date', 'unknown'].includes(column.type) && typeof value === 'string',
            table.id,
            'A cell has an unsupported type or storage representation.',
          );
        }
        return value as Canonical;
      });
      hash.update(canonicalize(values));
    }
    tableHashes.push(hash.digest('hex'));
    tableRows += rows;
  }
  requireValid(
    schema.every((row) => expectedNames.has(String(row.name))),
    'context.sqlite',
    'The catalog contains schema objects outside the supported build projection.',
  );
  const counts = {
    artifacts: artifacts.length,
    nodes: nodeById.size,
    chunks: chunkHashes.length,
    tables: tables.length,
    tableRows,
  };
  requireValid(
    hashCanonical(counts) === hashCanonical(manifest.counts),
    'manifest.json',
    'Catalog counts disagree with the manifest.',
  );
  const roots = {
    artifacts: hashRoot(artifacts.map((row) => hashCanonical([row.id, row.content_hash]))),
    nodes: hashRoot(nodeHashes),
    chunks: hashRoot(chunkHashes),
    tables: hashRoot(tableHashes),
    objects: hashRoot(artifacts.map((row) => row.object_hash)),
  };
  requireValid(
    hashCanonical(roots) === hashCanonical(manifest.canonicalRoots) &&
      hashCanonical(roots) === hashCanonical(inputs.canonicalRoots),
    'context.sqlite',
    'Recomputed canonical roots disagree with the package identity.',
  );
  const buildId = deriveBuildId({ ...inputs, canonicalRoots: roots });
  requireValid(
    buildId === manifest.buildId,
    'manifest.json',
    'The recorded build ID does not match its canonical inputs.',
  );
  return { buildId, objectHashes: artifacts.map((row) => row.object_hash), canonicalRoots: roots };
}

type ParsedGeometry = Pick<ParsedArtifact, 'artifact' | 'nodes'>;

export function checkStoredLocatorRanges(
  db: DatabaseSync,
  parsed: readonly ParsedGeometry[],
): readonly { readonly subject: string; readonly message: string }[] {
  try {
    verifyLocatorRanges(db, parsed);
    return [];
  } catch (error) {
    if (!(error instanceof LoreError)) throw error;
    return [
      {
        subject: error.subject ?? 'context.sqlite',
        message: error.message.replace(/^locator-ranges: /, ''),
      },
    ];
  }
}

function verifyLocatorRanges(db: DatabaseSync, parsed?: readonly ParsedGeometry[]): void {
  const expectedById =
    parsed === undefined ? undefined : new Map(parsed.map((entry) => [entry.artifact.id, entry]));
  for (const artifact of db
    .prepare('SELECT id, relative_path, metadata FROM artifacts')
    .iterate()) {
    const id = String(artifact.id);
    const relativePath = String(artifact.relative_path);
    const nodes = db
      .prepare('SELECT id, kind, line_start, line_end, metadata FROM nodes WHERE artifact_id=?')
      .all(id)
      .map((row) => {
        const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
        return {
          id: String(row.id),
          kind: row.kind as LoreNode['kind'],
          metadata,
          locator: {
            artifactId: id,
            relativePath,
            ...(row.line_start === null ? {} : { lineStart: Number(row.line_start) }),
            ...(row.line_end === null ? {} : { lineEnd: Number(row.line_end) }),
            ...(metadata.page === undefined ? {} : { page: metadata.page as number }),
            ...(metadata.sheet === undefined ? {} : { sheet: metadata.sheet as string }),
            ...(metadata.cellRange === undefined
              ? {}
              : { cellRange: metadata.cellRange as string }),
          },
        };
      });
    const expected = expectedById?.get(id);
    requireValid(
      expectedById === undefined || expected !== undefined,
      id,
      'locator-ranges: A stored artifact was not parsed.',
    );
    const bounds =
      expected === undefined
        ? locatorBounds(
            {
              id,
              relativePath,
              metadata: JSON.parse(String(artifact.metadata)) as Record<string, unknown>,
            },
            nodes,
          )
        : locatorBounds(expected.artifact, expected.nodes);
    const check = (subject: string, locator: SourceLocator): void => {
      const problem = locatorProblem(locator, bounds);
      requireValid(problem === undefined, subject, `locator-ranges: ${problem ?? ''}`);
    };
    for (const node of nodes) check(node.id, node.locator);
    for (const row of db
      .prepare(
        'SELECT id, relative_path, line_start, line_end, page FROM chunks WHERE artifact_id=?',
      )
      .iterate(id)) {
      check(String(row.id), {
        artifactId: id,
        relativePath: String(row.relative_path),
        ...(row.line_start === null ? {} : { lineStart: Number(row.line_start) }),
        ...(row.line_end === null ? {} : { lineEnd: Number(row.line_end) }),
        ...(row.page === null ? {} : { page: Number(row.page) }),
      });
    }
    for (const row of db
      .prepare(
        'SELECT id, relative_path, line_start, line_end, sheet, cell_range FROM tables WHERE artifact_id=?',
      )
      .iterate(id)) {
      check(String(row.id), {
        artifactId: id,
        relativePath: String(row.relative_path),
        ...(row.line_start === null ? {} : { lineStart: Number(row.line_start) }),
        ...(row.line_end === null ? {} : { lineEnd: Number(row.line_end) }),
        ...(row.sheet === null ? {} : { sheet: String(row.sheet) }),
        ...(row.cell_range === null ? {} : { cellRange: String(row.cell_range) }),
      });
    }
  }
}
