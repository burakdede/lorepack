#!/usr/bin/env node
// Reports whether this Node build's bundled SQLite has FTS5 and is at least 3.53.2, the
// release that fixes FTS5 memory corruption (CVE-2026-11822, CVE-2026-11824), with the
// facts that explain a failure. Used by CI and by anyone diagnosing an install.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:', { allowExtension: false });
const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;

let available = false;
let detail = null;
try {
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = 'unicode61')");
  db.exec("INSERT INTO probe(body) VALUES ('lorepack capability probe')");
  available =
    db.prepare("SELECT body FROM probe WHERE probe MATCH 'capability'").get() !== undefined;
  db.exec('DROP TABLE probe');
} catch (error) {
  detail = error instanceof Error ? error.message : String(error);
}
db.close();

const MINIMUM_SQLITE = [3, 53, 2];
const parts = sqliteVersion.split('.').map(Number);
const sqliteSupported =
  parts.length === 3 &&
  parts.every(Number.isInteger) &&
  (parts[0] - MINIMUM_SQLITE[0] || parts[1] - MINIMUM_SQLITE[1] || parts[2] - MINIMUM_SQLITE[2]) >=
    0;

const report = {
  available,
  sqliteVersion,
  sqliteSupported,
  minimumSqlite: MINIMUM_SQLITE.join('.'),
  nodeVersion: process.versions.node,
  platform: `${process.platform}-${process.arch}`,
  execPath: process.execPath,
  ...(detail === null ? {} : { detail }),
};

console.log(JSON.stringify(report, null, 2));
if (!available) {
  console.error('\nFTS5 is unavailable in this Node build, so Lorepack cannot run.');
  console.error('Install an official build: https://nodejs.org/en/download');
  console.error('See docs/compatibility/sqlite-fts5.md');
  process.exit(1);
}
if (!sqliteSupported) {
  console.error(
    `\nSQLite ${sqliteVersion} predates ${MINIMUM_SQLITE.join('.')}, which fixes FTS5 memory corruption.`,
  );
  console.error('Install Node 24.19.0 or newer: https://nodejs.org/en/download');
  console.error('See docs/compatibility/sqlite-fts5.md');
  process.exit(1);
}
