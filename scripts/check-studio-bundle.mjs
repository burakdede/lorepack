#!/usr/bin/env node
// Studio is an inspector, not an application, and it is downloaded from a local server by a
// person who is waiting. The budget exists so that stays true: a dependency that doubles the
// bundle should be a decision someone makes on purpose, not one that arrives in a lockfile.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'packages', 'cli', 'studio-dist');

// Generous enough that ordinary work does not trip it, tight enough that a UI framework or an
// icon set arriving by accident does.
const BUDGETS = { '.js': 420, '.css': 40, total: 700 };

if (!existsSync(ROOT)) {
  console.error(
    `check:studio-bundle: ${ROOT} is missing. Run \`pnpm --filter @lorepack/studio build\`.`,
  );
  process.exit(1);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT);
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
const problems = [];
let total = 0;

for (const extension of ['.js', '.css']) {
  const size = files
    .filter((file) => file.endsWith(extension))
    .reduce((sum, file) => sum + statSync(file).size, 0);
  if (kb(size) > BUDGETS[extension]) {
    problems.push(`${extension} is ${kb(size)} kB, over the ${BUDGETS[extension]} kB budget`);
  }
}

for (const file of files) total += statSync(file).size;
if (kb(total) > BUDGETS.total) {
  problems.push(`the bundle is ${kb(total)} kB, over the ${BUDGETS.total} kB budget`);
}

if (problems.length > 0) {
  console.error(`check:studio-bundle: ${problems.join('; ')}`);
  console.error('\nRaise the budget deliberately, or find what grew.');
  process.exit(1);
}

console.log(`check:studio-bundle: ${kb(total)} kB across ${files.length} files, within budget`);
