import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildIdInputsSchema, buildManifestSchema, LoreError } from '@lorepack/core';
import { verifyLogicalCatalog } from './catalog/verify.js';
import { openReadOnly } from './sqlite.js';

try {
  const [databasePath, manifestPath, inputsPath] = process.argv.slice(2);
  if (databasePath === undefined || manifestPath === undefined || inputsPath === undefined) {
    throw new Error('The verifier requires catalog, manifest and identity input files.');
  }
  const manifest = buildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const inputs = buildIdInputsSchema.parse(JSON.parse(readFileSync(inputsPath, 'utf8')));
  const db = openReadOnly(databasePath);
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const proof = verifyLogicalCatalog(
      db,
      manifest,
      inputs,
      join(dirname(databasePath), 'reference.sqlite'),
    );
    process.stdout.write(JSON.stringify({ ok: true, proof }));
  } finally {
    db.close();
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: error instanceof LoreError ? error.code : 'LORE_E_OBJECT_CORRUPT',
      subject: error instanceof LoreError ? error.subject : 'context.sqlite',
      message:
        error instanceof LoreError
          ? error.message
          : 'The package contains invalid catalog or identity data.',
    }),
  );
}
