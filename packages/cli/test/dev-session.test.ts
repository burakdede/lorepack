import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LoreError, loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import {
  assertNoLiveSession,
  DEV_PORT,
  isRunning,
  readReceipt,
  removeReceipt,
  writeReceipt,
} from '../src/services/dev-session.js';

/**
 * The dev session receipt: evidence about a running process, never a lock.
 *
 * The distinction is the whole design. A lock that outlives the thing it protects makes a
 * crash unrecoverable without deleting a file nobody told you about. A receipt that is
 * checked against reality every time cannot do that, so every test here is really about
 * what happens when the file and the world disagree.
 */

const CORPUS = {
  'lore.yaml': 'version: 1\nname: sessioned\nsources:\n  - .\n',
  'a.md': '# A\n\nFirst.\n',
};

const RECEIPT = {
  port: DEV_PORT,
  pid: process.pid,
  startedAt: '2026-08-03T12:00:00.000Z',
  buildId: `lore_${'a'.repeat(64)}`,
  host: '127.0.0.1',
};

describe('the preferred port', () => {
  it('is the one architecture 15.3 fixes', () => {
    // Written down here because it is a compatibility surface: a connector's generated
    // config and a person's bookmark both point at it.
    expect(DEV_PORT).toBe(43110);
  });
});

describe('writing and reading', () => {
  it('round-trips everything a reader needs to find the session', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      writeReceipt(config, RECEIPT);

      expect(readReceipt(config)).toEqual(RECEIPT);
      // At the path 15.3 names, because other tools are told to look there.
      expect(readFileSync(join(project.root, '.lore', 'dev.json'), 'utf8')).toContain('43110');
    });
  });

  it('leaves no partial file behind, because it renames into place', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      writeReceipt(config, RECEIPT);
      writeReceipt(config, { ...RECEIPT, port: 43111 });

      // A reader arriving between two writes sees one or the other, never half of one.
      expect(readReceipt(config)?.port).toBe(43111);
      const leftovers = readFileSync(join(project.root, '.lore', 'dev.json'), 'utf8');
      expect(() => JSON.parse(leftovers)).not.toThrow();
    });
  });

  it('treats an unreadable receipt as no receipt', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      mkdirSync(join(project.root, '.lore'), { recursive: true });
      writeFileSync(join(project.root, '.lore', 'dev.json'), '{ this is not json', 'utf8');

      // Refusing to start because of a corrupt file would make a crash unrecoverable
      // without knowing to delete it.
      expect(readReceipt(config)).toBeNull();
      expect(() => assertNoLiveSession(config)).not.toThrow();
    });
  });

  it('is gone after removal', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      writeReceipt(config, RECEIPT);
      removeReceipt(config);
      expect(readReceipt(config)).toBeNull();
      // Removing one that is not there is not an error: shutdown runs it unconditionally.
      expect(() => removeReceipt(config)).not.toThrow();
    });
  });
});

describe('asking whether the process is still there', () => {
  it('recognises this one', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  it('does not believe a pid that cannot exist', () => {
    expect(isRunning(-1)).toBe(false);
    expect(isRunning(0)).toBe(false);
  });
});

describe('a second supervisor on the same project', () => {
  it('is refused, and told where the first one is', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      // This process is unquestionably running, which is what makes the receipt live.
      writeReceipt(config, RECEIPT);

      let raised: LoreError | null = null;
      try {
        assertNoLiveSession(config);
      } catch (error) {
        raised = error as LoreError;
      }

      expect(raised).not.toBeNull();
      expect(raised?.code).toBe('LORE_E_LOCK_HELD');
      // Actionable means naming the session that exists, not just refusing.
      expect(raised?.message).toContain(String(DEV_PORT));
      expect(raised?.message).toContain(String(process.pid));
    });
  });

  it('starts anyway when the receipt names a process that is gone', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      // A pid that cannot be running: the machine restarted, or the process was killed hard
      // enough that it never cleaned up. Nothing is wrong, so nothing is reported.
      writeReceipt(config, { ...RECEIPT, pid: 0x7ffffffe });

      expect(() => assertNoLiveSession(config)).not.toThrow();
      // Cleared rather than left to confuse the next reader.
      expect(readReceipt(config)).toBeNull();
    });
  });

  it('does not refuse when there is no receipt at all', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      rmSync(join(project.root, '.lore', 'dev.json'), { force: true });
      expect(() => assertNoLiveSession(config)).not.toThrow();
    });
  });
});
