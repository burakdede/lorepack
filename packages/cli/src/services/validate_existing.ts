import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalRuntimeBackend,
  FileObjectStore,
  verifyCatalogFiles,
} from '@lorepack/backend-local';
import { type BuildId, LORE_DIRECTORY, LoreError, type ProjectConfig } from '@lorepack/core';
import { buildDirectory } from './builds.js';

export interface ExistingBuildValidation {
  readonly mode: 'existing-build';
  readonly buildId: BuildId;
  readonly ok: true;
  readonly checks: readonly { readonly name: string; readonly ok: true }[];
  readonly objectCount: number;
}

export async function validateExistingBuild(
  config: ProjectConfig,
  buildId: BuildId,
  signal?: AbortSignal,
): Promise<ExistingBuildValidation> {
  if (signal?.aborted) throw cancelledVerification();
  if (!existsSync(join(config.projectRoot, LORE_DIRECTORY, 'state.sqlite'))) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no retained builds.', {
      remediation: 'Build or import the selected build before validating it.',
      subject: buildId,
    });
  }
  const scratch = mkdtempSync(join(tmpdir(), 'lore-validate-existing-'));
  try {
    const backend = createLocalRuntimeBackend({ projectRoot: config.projectRoot });
    try {
      const objects = new FileObjectStore(join(config.projectRoot, LORE_DIRECTORY, 'objects'));
      const handle = await backend.provider.acquire({ buildId });
      try {
        const directory = buildDirectory(join(config.projectRoot, LORE_DIRECTORY), handle.buildId);
        const inputs = join(directory, 'reports', 'build-id-inputs.json');
        if (!existsSync(inputs)) {
          throw new LoreError(
            'LORE_E_SCHEMA_MISMATCH',
            'This retained build lacks saved identity inputs.',
            {
              remediation:
                'Source-free verification is unsupported for this build. Restore a compatible package or compile a new candidate.',
              subject: buildId,
            },
          );
        }
        copyFileSync(join(directory, 'context.sqlite'), join(scratch, 'context.sqlite'));
        copyFileSync(join(directory, 'manifest.json'), join(scratch, 'manifest.json'));
        copyFileSync(inputs, join(scratch, 'build-id-inputs.json'));
        const proof = await verifyCatalogFiles(scratch, signal);
        if (proof.buildId !== handle.buildId) {
          throw new LoreError(
            'LORE_E_OBJECT_CORRUPT',
            'The selected build disagrees with its sealed identity.',
            {
              remediation: 'Restore the retained build from a verified package.',
              subject: buildId,
            },
          );
        }
        const hashes = [...new Set(proof.objectHashes)];
        for (const hash of hashes) {
          if (!(await objects.verify(hash, signal))) {
            throw new LoreError('LORE_E_OBJECT_CORRUPT', 'A selected build object is missing.', {
              remediation: 'Restore the retained build and objects from a verified package.',
              subject: hash,
            });
          }
        }
        return {
          mode: 'existing-build',
          buildId: handle.buildId,
          ok: true,
          checks: [
            { name: 'sealed-catalog', ok: true },
            { name: 'object-checksums', ok: true },
            { name: 'locator-ranges', ok: true },
            { name: 'table-mapping', ok: true },
          ],
          objectCount: hashes.length,
        };
      } finally {
        await handle.release();
      }
    } finally {
      backend.close();
    }
  } catch (error) {
    if (signal?.aborted) throw cancelledVerification();
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function cancelledVerification(): LoreError {
  return new LoreError('LORE_E_CANCELLED', 'Retained-build verification was cancelled.', {
    remediation: 'Retained build data and the active pointer were not changed.',
  });
}
