#!/usr/bin/env node
/**
 * The `lorepack` entry point.
 *
 * The engine guard runs before anything heavy is imported, so an unsupported runtime
 * produces one actionable line instead of a module-load failure from deep inside a
 * dependency. That import ordering is load-bearing: `assertSupportedNode` comes from a
 * module with no transitive imports beyond node builtins, and everything else is loaded
 * dynamically afterwards.
 *
 * The SQLite check comes second and imports `node:sqlite` dynamically, because a Node old
 * enough to lack the module must be refused by the Node check rather than crash on import.
 * It is separate from the Node check because a Node linked against a shared system SQLite
 * reports whatever that library is, and only the library version proves the FTS5 fixes.
 *
 * This file is deliberately not in a directory called `bin`. Ignoring `bin/` is a common
 * entry in a personal global gitignore, and it silently kept this file out of the first
 * commit until CI failed on the missing source.
 */
import { assertSupportedNode, assertSupportedSqlite } from '@lorepack/core/engine';

assertSupportedNode();

const { DatabaseSync } = await import('node:sqlite');
const probe = new DatabaseSync(':memory:');
const { version } = probe.prepare('SELECT sqlite_version() AS version').get() as {
  version: string;
};
probe.close();
assertSupportedSqlite(version);

const { runCli } = await import('./framework/program.js');
await runCli(process.argv);
