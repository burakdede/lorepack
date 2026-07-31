#!/usr/bin/env node
/**
 * The `lore` entry point.
 *
 * The engine guard runs before anything heavy is imported, so an unsupported runtime
 * produces one actionable line instead of a module-load failure from deep inside a
 * dependency. That import ordering is load-bearing: `assertSupportedNode` comes from a
 * module with no transitive imports beyond node builtins, and everything else is loaded
 * dynamically afterwards.
 *
 * This file is deliberately not in a directory called `bin`. Ignoring `bin/` is a common
 * entry in a personal global gitignore, and it silently kept this file out of the first
 * commit until CI failed on the missing source.
 */
import { assertSupportedNode } from '@lorepack/core/engine';

assertSupportedNode();

const { runCli } = await import('./framework/program.js');
await runCli(process.argv);
