import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  extractVerifiedArchive,
  LocalStateStore,
  ProjectLock,
  sealCandidateDirectory,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import {
  assertBuildId,
  buildManifestSchema,
  CONFIG_FILENAME,
  findProjectRoot,
  fsyncDirectory,
  LORE_DIRECTORY,
  LoreError,
  loadProjectConfig,
  loreDirectoryEscape,
} from '@lorepack/core';

export async function importArchive(cwd: string, file: string) {
  const root = realpathSync(resolve(cwd));
  const archive = resolve(root, file);
  if (!existsSync(archive)) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'The archive does not exist.', {
      remediation: 'Pass the path to a local .lorepack file. Relative paths use --cwd.',
    });
  }
  const found = findProjectRoot(root);
  if (found !== null && found !== root) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', 'Import must run at the project root.', {
      remediation: `Pass --cwd ${found}, or an empty directory outside that project.`,
    });
  }
  if (found !== null) loadProjectConfig({ cwd: root });
  if (loreDirectoryEscape(root) !== null) {
    throw new LoreError('LORE_E_PATH_ESCAPE', 'The import store escapes the project.', {
      remediation: 'Remove the .lore link before importing.',
    });
  }
  const lore = join(root, LORE_DIRECTORY);
  safeDirectory(lore);
  return await new ProjectLock(join(lore, 'lock')).withLock(async () => {
    const temporary = join(lore, 'tmp');
    safeDirectory(temporary);
    const staging = join(temporary, `import-${randomUUID()}`);
    try {
      const proof = await extractVerifiedArchive(archive, staging);
      const build = join(staging, 'build');
      const manifest = buildManifestSchema.parse(
        JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8')),
      );
      const builds = join(lore, 'builds');
      safeDirectory(builds);
      const destination = join(builds, manifest.buildId);
      if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) {
        throw new LoreError('LORE_E_INVALID_ARGUMENT', 'This immutable build already exists.', {
          remediation: 'Inspect or activate the retained build. Import never overwrites it.',
          subject: manifest.buildId,
        });
      }
      const objects = join(staging, 'objects', 'sha256');
      if (existsSync(objects)) {
        for (const first of readdirSync(objects)) {
          for (const second of readdirSync(join(objects, first))) {
            for (const tail of readdirSync(join(objects, first, second))) {
              const source = join(objects, first, second, tail);
              const target = join(lore, 'objects', 'sha256', first, second, tail);
              safeDirectory(dirname(target));
              const existing = lstatSync(target, { throwIfNoEntry: false });
              if (existing !== undefined) {
                if (!existing.isFile() || (await digest(target)) !== first + second + tail) {
                  throw new LoreError('LORE_E_OBJECT_CORRUPT', 'A retained object is corrupt.', {
                    remediation: 'Restore the object before importing. Import never repairs it.',
                    subject: first + second + tail,
                  });
                }
              } else {
                renameSync(source, target);
                fsyncDirectory(dirname(target));
              }
            }
          }
        }
      }
      const configPath = join(root, CONFIG_FILENAME);
      if (found === null) {
        const fd = openSync(configPath, 'wx', 0o600);
        try {
          writeFileSync(
            fd,
            `version: 1\nname: ${JSON.stringify(manifest.projectName)}\nsources:\n  - __lorepack_sources_not_imported__\n`,
          );
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        fsyncDirectory(root);
      }
      const state = LocalStateStore.open(lore, stateMigrationsDirectory());
      try {
        sealCandidateDirectory({ path: build }, destination);
        state.recordBuild({
          buildId: assertBuildId(manifest.buildId),
          state: 'verified',
          createdAt: new Date().toISOString(),
          counts: manifest.counts,
        });
        return {
          buildId: manifest.buildId,
          activated: false,
          projectRoot: root,
          assurance: proof.assurance,
          authenticated: proof.authenticated,
        };
      } finally {
        state.close();
      }
    } finally {
      rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

function safeDirectory(path: string): void {
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isDirectory()) {
      throw new LoreError(
        'LORE_E_PATH_ESCAPE',
        'The import store contains a link or non-directory.',
        {
          remediation: 'Restore ordinary store directories before importing.',
        },
      );
    }
    return;
  }
  mkdirSync(path, { mode: 0o700 });
  fsyncDirectory(dirname(path));
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
