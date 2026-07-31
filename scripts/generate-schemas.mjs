#!/usr/bin/env node
// Regenerates schemas/*.json from the Zod definitions in @lorepack/core.
// Run with --check in CI: it fails when a Zod schema changed without regenerating.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PUBLIC_SCHEMAS } from '../packages/core/dist/schemas/registry.js';

const OUT_DIR = 'schemas';
const check = process.argv.includes('--check');
const BASE_URI = 'https://lorepack.dev/schemas';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function render(name, schema) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${BASE_URI}/${name}.json`,
    title: name,
    ...jsonSchema,
  };
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}

mkdirSync(OUT_DIR, { recursive: true });
const expected = new Map();
for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) {
  expected.set(`${name}.json`, render(name, schema));
}

const problems = [];
for (const [file, contents] of expected) {
  const path = join(OUT_DIR, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === contents) continue;
  if (check) {
    problems.push(current === null ? `${path} is missing` : `${path} is out of date`);
  } else {
    writeFileSync(path, contents, 'utf8');
  }
}

const stale = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && !expected.has(f));
for (const file of stale) {
  if (check) problems.push(`${join(OUT_DIR, file)} has no matching Zod schema`);
  else rmSync(join(OUT_DIR, file));
}

if (problems.length > 0) {
  console.error('Committed JSON Schemas do not match the Zod definitions.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nRun `pnpm schemas:generate` and commit the result.');
  process.exit(1);
}
console.log(
  check
    ? `schemas:check: ${expected.size} schemas match`
    : `schemas:generate: wrote ${expected.size} schemas to ${OUT_DIR}/`,
);
