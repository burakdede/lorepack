import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifestSchema } from '@lorepack/core';
import {
  cmapBombPdf,
  docxBomb,
  numericCsv,
  singleCharacterCsv,
  streamedFlateBombPdf,
  withTempProject,
} from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { readActiveBuild } from '../src/services/project.js';
import { measureCliMemory } from './support/process_memory.js';

const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const CASES = [
  { path: 'flate.pdf', fixture: () => streamedFlateBombPdf(1500), heap: 2048, resident: true },
  { path: 'cmap.pdf', fixture: () => cmapBombPdf(8), heap: 2048, resident: true },
  { path: 'document.docx', fixture: () => docxBomb(64), heap: 128, resident: false },
  { path: 'rows.csv', fixture: () => singleCharacterCsv(4_000_000), heap: 128, resident: false },
] as const;

for (const entry of CASES) {
  it(`bounds ${entry.path} through the shipped CLI and preserves retained builds, issue677`, async () => {
    const observerDiagnostic =
      process.platform === 'win32' && entry.path === 'flate.pdf'
        ? { LOREPACK_OBSERVER_DIAGNOSTIC: '1' }
        : {};
    const bytes = await entry.fixture();
    const memoryInput =
      entry.path === 'rows.csv'
        ? { path: 'rows_memory.csv', bytes: numericCsv(500_000, 8) }
        : undefined;
    await withTempProject(
      {
        files: { 'lore.yaml': 'version: 1\nname: memory\nsources: [.]\n', 'ready.md': '# Ready\n' },
      },
      async (temp) => {
        const run = (...args: string[]) =>
          JSON.parse(
            execFileSync(process.execPath, [BINARY, '--cwd', temp.root, '--json', ...args], {
              encoding: 'utf8',
              timeout: 45_000,
              env: {
                ...process.env,
                ...observerDiagnostic,
                LORE_PARSE_TIMEOUT_MS: '30000',
                LORE_PARSE_MEMORY_MB: String(entry.heap),
                LORE_PARSE_RSS_MB: '1024',
              },
            }),
          );
        const first = run('build');
        const manifestPath = (buildId: string) =>
          join(temp.root, '.lore', 'builds', buildId, 'manifest.json');
        const original = readFileSync(manifestPath(first.buildId));
        writeFileSync(join(temp.root, entry.path), bytes);
        if (memoryInput !== undefined) {
          writeFileSync(join(temp.root, memoryInput.path), memoryInput.bytes);
        }
        writeFileSync(join(temp.root, 'ready.md'), '# Ready\n\nA new retained paragraph.\n');

        const measured = await measureCliMemory([BINARY, '--cwd', temp.root, '--json', 'build'], {
          ...process.env,
          ...observerDiagnostic,
          LORE_PARSE_TIMEOUT_MS: '30000',
          LORE_PARSE_MEMORY_MB: String(entry.heap),
          LORE_PARSE_RSS_MB: '1024',
        });
        const maximum = (role?: string) =>
          Math.max(
            0,
            ...measured.samples.map((sample) =>
              sample.processes
                .filter((row) => role === undefined || row.role === role)
                .reduce((total, row) => total + row.rssBytes, 0),
            ),
          );
        const observedParserBytes = maximum('parser');
        const evidenceDirectory = join(
          import.meta.dirname,
          '../../../coverage/parser-memory',
          String(process.pid),
        );
        mkdirSync(evidenceDirectory, { recursive: true });
        const evidencePath = join(evidenceDirectory, `${entry.path}.json`);
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              source: {
                head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
                dirty:
                  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !==
                  '',
                cliSha256: createHash('sha256').update(readFileSync(BINARY)).digest('hex'),
              },
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              fixture: {
                path: entry.path,
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
              additionalFixtures:
                memoryInput === undefined
                  ? []
                  : [
                      {
                        path: memoryInput.path,
                        bytes: memoryInput.bytes.byteLength,
                        sha256: createHash('sha256').update(memoryInput.bytes).digest('hex'),
                      },
                    ],
              controls: {
                heapMiB: entry.heap,
                timeoutMs: 30_000,
                residentThresholdMiB: 1024,
                observedEnvelopeMiB: 1536,
              },
              observation: {
                intervalAfterSnapshotMs: 100,
                method: process.platform === 'win32' ? 'Win32_Process CIM' : 'ps RSS in KiB',
                limitation: 'Independent sampled maxima, not atomic peaks or hard memory quotas.',
                observedParserBytes,
                observedWholeTreeBytes: maximum(),
                observedObserverBytes: maximum('observer'),
              },
              ...measured,
            },
            null,
            2,
          ),
        );
        expect(measured.observerError).toBeNull();
        expect(measured.code, measured.stderr).toBe(0);
        expect(measured.signal).toBeNull();
        expect(measured.durationMs).toBeLessThan(45_000);
        expect(measured.parserPids.length).toBeGreaterThan(0);
        expect(observedParserBytes).toBeGreaterThan(0);
        expect(observedParserBytes).toBeLessThanOrEqual(1536 * 1024 * 1024);
        expect(measured.remainingPids).toEqual([]);
        const built = JSON.parse(measured.stdout);
        expect(built).toMatchObject({
          activated: true,
          created: true,
          counts: { artifacts: memoryInput === undefined ? 1 : 2 },
        });
        const manifest = buildManifestSchema.parse(
          JSON.parse(readFileSync(manifestPath(built.buildId), 'utf8')),
        );
        const expectedWarnings = [
          expect.objectContaining({
            code: 'parse-memory',
            class: 'envelope',
            path: memoryInput?.path ?? entry.path,
          }),
          ...(memoryInput === undefined
            ? []
            : [expect.objectContaining({ code: 'csv-too-many-rows', path: entry.path })]),
        ];
        expect(manifest.warnings).toHaveLength(expectedWarnings.length);
        expect(manifest.warnings).toEqual(expect.arrayContaining(expectedWarnings));
        const warning = manifest.warnings.find(({ code }) => code === 'parse-memory');
        if (entry.resident) {
          expect(warning?.message).toContain('1024 MiB resident memory budget');
          expect(warning?.message).toContain('LORE_PARSE_RSS_MB');
        }
        const inspected = run('inspect', 'warnings');
        expect(inspected).toMatchObject({
          buildId: built.buildId,
          total: expectedWarnings.length,
          warnings: expect.arrayContaining(expectedWarnings),
        });
        expect(inspected.warnings).toHaveLength(expectedWarnings.length);
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              ...JSON.parse(readFileSync(evidencePath, 'utf8')),
              manifestWarnings: manifest.warnings,
              inspectedWarnings: inspected,
            },
            null,
            2,
          ),
        );
        expect(readActiveBuild(join(temp.root, '.lore'))?.buildId).toBe(built.buildId);
        expect(readFileSync(manifestPath(first.buildId))).toEqual(original);
        expect(existsSync(join(temp.root, '.lore', 'lock'))).toBe(false);

        const repeated = run('build');
        expect(repeated).toMatchObject({
          buildId: built.buildId,
          created: false,
          activated: false,
        });
        expect(readActiveBuild(join(temp.root, '.lore'))?.buildId).toBe(built.buildId);
        expect(existsSync(join(temp.root, '.lore', 'lock'))).toBe(false);
      },
    );
  });
}
