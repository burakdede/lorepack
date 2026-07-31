import { DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';
import { sqliteVersion } from './sqlite.js';

/**
 * FTS5 is the whole of v0.1 retrieval, so its absence must fail fast with a fix rather
 * than surface later as an empty search.
 *
 * Official Node builds compile SQLITE_ENABLE_FTS5 (nodejs/node#57621, in every release
 * from 24.0). A Node linked against a shared system SQLite may not, which is why this
 * probe exists rather than a version check.
 */

export interface Fts5ProbeResult {
  readonly available: boolean;
  readonly sqliteVersion: string;
  readonly nodeVersion: string;
  readonly execPath: string;
  readonly detail?: string;
}

export function probeFts5(): Fts5ProbeResult {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  const context = {
    sqliteVersion: sqliteVersion(db),
    nodeVersion: process.versions.node,
    execPath: process.execPath,
  };
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = 'unicode61')");
    db.exec("INSERT INTO probe(body) VALUES ('lorepack capability probe')");
    const row = db.prepare("SELECT body FROM probe WHERE probe MATCH 'capability'").get() as
      | { body?: string }
      | undefined;
    db.exec('DROP TABLE probe');
    if (row?.body === undefined) {
      return { available: false, ...context, detail: 'FTS5 matched no rows for a known term.' };
    }
    return { available: true, ...context };
  } catch (cause) {
    return {
      available: false,
      ...context,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    db.close();
  }
}

export function assertFts5Available(result: Fts5ProbeResult = probeFts5()): void {
  if (result.available) return;
  throw new LoreError(
    'LORE_E_FTS5_UNAVAILABLE',
    `This Node build has SQLite ${result.sqliteVersion} without FTS5, so lexical search cannot work.`,
    {
      remediation: [
        'Install an official Node build, which compiles FTS5:',
        '  https://nodejs.org/en/download',
        '  or: nvm install 24 | fnm use 24 | mise use node@24',
        'A Node linked against a shared system SQLite may omit it.',
        'See docs/compatibility/sqlite-fts5.md',
      ].join('\n'),
      details: {
        sqliteVersion: result.sqliteVersion,
        nodeVersion: result.nodeVersion,
        execPath: result.execPath,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      },
    },
  );
}
