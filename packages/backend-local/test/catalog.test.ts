import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, LoreNode } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import {
  type CatalogArtifact,
  countRows,
  escapeFtsQuery,
  searchCatalog,
  writeCatalog,
} from '../src/catalog/writer.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { integrityCheck, openWritable } from '../src/sqlite.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', 'migrations');
const BUILD_MIGRATIONS = join(ROOT, 'build');

function artifact(id: string, title: string, status = 'active'): Artifact {
  return {
    id,
    sourceId: 'src',
    relativePath: `${id.split(':')[1]}`,
    displayPath: `${id.split(':')[1]}`,
    mediaType: 'text/markdown',
    byteSize: 100,
    contentHash: 'a'.repeat(64),
    parserId: 'markdown',
    parserVersion: '0.1.0',
    title,
    status: status as Artifact['status'],
    authority: 50,
    supersedes: [],
    metadata: {},
  };
}

function node(artifactId: string, index: number, text: string): LoreNode {
  return {
    id: `${artifactId}#0.${index}`,
    artifactId,
    kind: 'paragraph',
    ordinal: index,
    text,
    locator: {
      artifactId,
      relativePath: artifactId.split(':')[1] ?? '',
      lineStart: index,
      lineEnd: index,
    },
    metadata: {},
    revisionHash: 'b'.repeat(64),
  };
}

function entry(id: string, title: string, texts: string[], status = 'active'): CatalogArtifact {
  const nodes = texts.map((text, index) => node(id, index + 1, text));
  return {
    artifact: artifact(id, title, status),
    nodes,
    objectHash: 'c'.repeat(64),
    chunks: texts.map((text, index) => ({
      id: `${id}@${index}`,
      artifactId: id,
      nodeIds: [nodes[index]?.id ?? ''],
      headingPath: ['Section'],
      text,
      estimatedTokens: 10,
      locator: { relativePath: id.split(':')[1] ?? '', lineStart: 1, lineEnd: 2 },
      revisionHash: 'd'.repeat(64),
    })),
  };
}

async function withCatalog(
  entries: readonly CatalogArtifact[],
  run: (db: DatabaseSync) => void,
): Promise<void> {
  await withTempProject({}, (project) => {
    const db = openWritable(project.path('context.sqlite'));
    try {
      runMigrations(db, loadMigrations(BUILD_MIGRATIONS));
      writeCatalog({ db, artifacts: entries });
      run(db);
    } finally {
      db.close();
    }
  });
}

describe('schema', () => {
  it('creates every catalog table including the FTS5 index', async () => {
    await withCatalog([], (db) => {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);

      for (const table of ['artifacts', 'nodes', 'chunks', 'supersessions', 'chunks_fts']) {
        expect(tables, table).toContain(table);
      }
    });
  });

  it('passes an integrity check after writing', async () => {
    await withCatalog([entry('src:a.md', 'A', ['hello world'])], (db) => {
      expect(integrityCheck(db).ok).toBe(true);
    });
  });
});

describe('writing', () => {
  it('stores artifacts, nodes and chunks with matching counts', async () => {
    await withCatalog(
      [entry('src:a.md', 'A', ['one', 'two']), entry('src:b.md', 'B', ['three'])],
      (db) => {
        expect(countRows(db, 'artifacts')).toBe(2);
        expect(countRows(db, 'nodes')).toBe(3);
        expect(countRows(db, 'chunks')).toBe(3);
      },
    );
  });

  it('keeps the FTS row count equal to the chunk count, which the validator checks', async () => {
    await withCatalog([entry('src:a.md', 'A', ['one', 'two', 'three'])], (db) => {
      expect(countRows(db, 'chunks_fts')).toBe(countRows(db, 'chunks'));
    });
  });

  it('rolls back completely when a write fails part way', async () => {
    await withTempProject({}, (project) => {
      const db = openWritable(project.path('context.sqlite'));
      try {
        runMigrations(db, loadMigrations(BUILD_MIGRATIONS));
        const good = entry('src:a.md', 'A', ['one']);
        // Two artifacts with the same id violate the primary key on the second insert.
        expect(() => writeCatalog({ db, artifacts: [good, good] })).toThrow();
        expect(countRows(db, 'artifacts')).toBe(0);
        expect(countRows(db, 'chunks')).toBe(0);
        expect(countRows(db, 'chunks_fts')).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it('records supersession relationships', async () => {
    const superseding = entry('src:v2.md', 'V2', ['new']);
    const withSupersedes: CatalogArtifact = {
      ...superseding,
      artifact: { ...superseding.artifact, supersedes: ['src:v1.md'] },
    };
    await withCatalog([withSupersedes], (db) => {
      expect(countRows(db, 'supersessions')).toBe(1);
    });
  });
});

describe('search', () => {
  const corpus = [
    entry('src:pricing.md', 'Pricing', ['Operator prices changed in July.']),
    entry('src:strategy.md', 'Strategy', ['The wedge is the lifecycle, not retrieval.']),
    entry('src:archive.md', 'Old', ['Historical pricing notes.'], 'archived'),
  ];

  it('finds chunks by term and returns provenance with every hit', async () => {
    await withCatalog(corpus, (db) => {
      const hits = searchCatalog(db, 'pricing');
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.relativePath).not.toBe('');
        expect(hit.chunkId).not.toBe('');
        expect(hit.artifactId).not.toBe('');
      }
    });
  });

  it('exposes status and authority so the runtime can rank without a second query', async () => {
    await withCatalog(corpus, (db) => {
      const hits = searchCatalog(db, 'pricing');
      const archived = hits.find((hit) => hit.artifactId === 'src:archive.md');
      expect(archived?.status).toBe('archived');
      expect(archived?.authority).toBe(50);
    });
  });

  it('returns nothing for a term that does not appear', async () => {
    await withCatalog(corpus, (db) => {
      expect(searchCatalog(db, 'kubernetes')).toEqual([]);
    });
  });

  it('matches accents and case insensitively', async () => {
    await withCatalog([entry('src:cafe.md', 'Cafe', ['Le café est ouvert.'])], (db) => {
      expect(searchCatalog(db, 'CAFE').length).toBeGreaterThan(0);
    });
  });
});

describe('query escaping', () => {
  it.each([
    ['simple query', '"simple" "query"'],
    ['with "quotes"', '"with" """quotes"""'],
    ['NEAR AND OR', '"NEAR" "AND" "OR"'],
    ['wildcard*', '"wildcard*"'],
    ['  spaced   out  ', '"spaced" "out"'],
  ])('escapes %s', (input, expected) => {
    expect(escapeFtsQuery(input)).toBe(expected);
  });

  it('produces an empty match for an empty query rather than a syntax error', () => {
    expect(escapeFtsQuery('   ')).toBe('');
  });

  it.each(['"', '*', ':', '(', ')', '^', 'NEAR("a" "b")', 'a OR b', '-x', 'a AND NOT b'])(
    'never throws for hostile input %s',
    async (query) => {
      await withCatalog([entry('src:a.md', 'A', ['hello'])], (db) => {
        expect(() => searchCatalog(db, query)).not.toThrow();
      });
    },
  );

  it('treats operators as literal text, so search is predictable', async () => {
    await withCatalog(
      [entry('src:a.md', 'A', ['alpha beta']), entry('src:b.md', 'B', ['alpha gamma'])],
      (db) => {
        // If OR were an operator this would match both. As literal text it matches neither.
        expect(searchCatalog(db, 'beta OR gamma')).toHaveLength(0);
      },
    );
  });
});

describe('scale', () => {
  it('writes several thousand chunks in one transaction', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entry(
        `src:file-${i}.md`,
        `File ${i}`,
        Array.from({ length: 50 }, (_, j) => `Chunk ${j} of file ${i} with searchable words.`),
      ),
    );
    await withCatalog(many, (db) => {
      expect(countRows(db, 'chunks')).toBe(2000);
      expect(countRows(db, 'chunks_fts')).toBe(2000);
      expect(searchCatalog(db, 'searchable', 5)).toHaveLength(5);
    });
  });
});
