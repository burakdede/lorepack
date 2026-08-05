import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { PARSERS } from '@lorepack/parsers';
import { makeXlsx, number, row, shared, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { lockInputs, parserVersions } from '../src/services/versions.js';

/**
 * Every parser's version reaches build identity (#234).
 *
 * The defect these exist for: `lockInputs` named markdown and text in a hand-written literal,
 * and the five parsers Phase 5 added were never appended. So bumping the XLSX parser's version
 * and rebuilding a project full of spreadsheets produced the same build id, and `lore diff`
 * between two builds whose content genuinely differed reported no change.
 *
 * A presence check would not have caught it. `parserVersions` was non-empty the whole time.
 * What was false was an *equality*, between the registry and what identity is computed from,
 * so that is what is asserted here.
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

function build(root: string) {
  return runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
}

/** A one-sheet workbook, so the XLSX parser genuinely contributes to the build under test. */
function workbook(): Promise<Uint8Array> {
  return makeXlsx({
    sharedStrings: ['sku', 'qty', 'A-1'],
    sheets: [
      {
        name: 'Orders',
        rows: [
          row(1, [shared('A1', 0), shared('B1', 1)]),
          row(2, [shared('A2', 2), number('B2', 5)]),
        ],
      },
    ],
  });
}

/**
 * Builds the same tree twice, with `mutate` applied in between, and returns both ids.
 *
 * Two temp roots rather than one rebuilt in place, so an unchanged id cannot be explained by
 * a cache or a reused build directory. Different absolute paths are also the determinism
 * condition, so an id that moved between them would be a different defect and would show up
 * here as a failure of the control case.
 */
async function idsAcross(
  files: Record<string, string | Uint8Array>,
  mutate: () => void,
): Promise<{ before: string; after: string }> {
  const materialise = async (): Promise<string> =>
    withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => {
      for (const [name, contents] of Object.entries(files)) {
        writeFileSync(join(temp.root, name), contents);
      }
      return (await build(temp.root)).buildId;
    });

  const before = await materialise();
  mutate();
  const after = await materialise();
  return { before, after };
}

/**
 * Builds `files` twice with the named parser bumped in between, and returns both ids.
 *
 * The registry entry is mutated rather than the exported constant, because identity is meant
 * to follow the registry, and that is exactly what a real version bump changes.
 */
async function idsAcrossBump(
  id: string,
  files: Record<string, string | Uint8Array>,
): Promise<{ before: string; after: string }> {
  const parser = PARSERS.find((one) => one.id === id);
  if (parser === undefined) throw new Error(`the ${id} parser is not registered`);
  const original = parser.version;
  const set = (value: string): void => {
    Object.defineProperty(parser, 'version', { value, configurable: true });
  };

  try {
    return await idsAcross(files, () => {
      set('9.9.9');
    });
  } finally {
    set(original);
  }
}

describe('parser versions in build identity', () => {
  it('records every registered parser, with the version the registry holds', () => {
    const versions = parserVersions();

    expect(Object.keys(versions).sort()).toEqual(PARSERS.map((parser) => parser.id).sort());
    for (const parser of PARSERS) expect(versions[parser.id]).toBe(parser.version);
  });

  it('carries every registered parser into the lockfile inputs', () => {
    expect(lockInputs().parserVersions).toEqual(parserVersions());
  });

  it('writes every registered parser to the lockfile of a real build', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A\n\nText.' } },
      async (temp) => {
        await build(temp.root);

        // Read as text rather than parsed: the lockfile is a file a person reviews in a diff,
        // and each parser must be visible in it by name.
        const lock = readFileSync(join(temp.root, 'lore.lock'), 'utf8');
        const parsers = lock.slice(lock.indexOf('parsers:'));
        for (const parser of PARSERS) {
          expect(parsers).toContain(`${parser.id}: ${parser.version}`);
        }
      },
    );
  });

  /**
   * The mutation drill from #234, as a test.
   *
   * On the old code this produced one id twice, for a project made almost entirely of the
   * file the bumped parser reads.
   */
  it('changes the build id when a contributing parser is bumped', async () => {
    const ids = await idsAcrossBump('xlsx', { 'orders.xlsx': await workbook() });

    expect(ids.after).not.toBe(ids.before);
  });

  /**
   * The decision recorded in `versions.ts`, asserted rather than left as prose.
   *
   * Identity depends on *every registered* parser, not only the ones a project used, because
   * the lockfile is written during planning before anything is parsed. Narrowing it to
   * contributing parsers later fails here and sends the reader to the reasoning.
   */
  it('depends on a parser that contributed nothing to this project', async () => {
    const ids = await idsAcrossBump('xlsx', { 'a.md': '# A\n\nText.' });

    expect(ids.after).not.toBe(ids.before);
  });

  /** The control: with nothing mutated, two builds of one tree at two paths agree. */
  it('produces the same id twice when no version moved', async () => {
    const bytes = await workbook();
    const ids = await idsAcross({ 'orders.xlsx': bytes }, () => {});

    expect(ids.after).toBe(ids.before);
  });
});
