#!/usr/bin/env node
// Reports whether this Node build's bundled SQLite has FTS5, with the facts that
// explain a failure. Used by CI and by anyone diagnosing an install.
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

const report = {
  available,
  sqliteVersion,
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
