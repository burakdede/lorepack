import { EventEmitter, once } from 'node:events';
import { lstatSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import type { ChokidarOptions } from 'chokidar';
import { beforeEach, expect, it, vi } from 'vitest';
import { resolveRealPath, startWatching } from '../src/services/watch.js';

const mocked = vi.hoisted(() => ({
  watch: vi.fn<(path: string, options: ChokidarOptions) => EventEmitter>(),
}));
vi.mock('chokidar', () => ({ watch: mocked.watch }));
beforeEach(() => {
  mocked.watch.mockReset();
  mocked.watch.mockImplementation(() => {
    const events = Object.assign(new EventEmitter(), {
      close: async () => {},
      getWatched: () => ({}),
    });
    queueMicrotask(() => events.emit('ready'));
    return events;
  });
});

function classify(root: string) {
  const watching = startWatching({
    config: loadConfig({ cwd: root }),
    warn: () => {},
    rebuild: async () => {
      throw new Error('Classification must not build.');
    },
  });
  const ignored = mocked.watch.mock.calls.at(-1)?.[1].ignored;
  if (typeof ignored !== 'function') throw new Error('Expected the actual ignored callback.');
  return { watching, ignored };
}
const files = {
  'lore.yaml': 'version: 1\nname: special-watch\nsources: [.]\n',
  'docs/a.md': '# A',
};

// Windows named pipes are not POSIX filesystem socket entries.
it.skipIf(process.platform === 'win32')(
  'does not ask Chokidar to watch an actual socket',
  async () => {
    await withTempProject({ files }, async ({ root }) => {
      const socket = createServer();
      const path = join(resolveRealPath(root), 's.sock');
      socket.listen(path);
      await once(socket, 'listening');
      const { watching, ignored } = classify(root);
      try {
        expect(ignored(path)).toBe(false);
        expect(ignored(path, statSync(path))).toBe(true);
      } finally {
        await watching.close();
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);

it('keeps pre-stat and regular file/directory decisions available', async () => {
  await withTempProject({ files }, async ({ root }) => {
    const { watching, ignored } = classify(root);
    try {
      for (const relative of ['docs', 'docs/a.md']) {
        const path = join(resolveRealPath(root), relative);
        expect(ignored(path)).toBe(false);
        expect(ignored(path, statSync(path))).toBe(false);
      }
    } finally {
      await watching.close();
    }
  });
});

it('preserves symlink classification instead of treating a link as a special entry', async () => {
  await withTempProject({ files }, async ({ root }) => {
    const path = join(resolveRealPath(root), 'linked.md');
    symlinkSync(join(root, 'docs/a.md'), path);
    const { watching, ignored } = classify(root);
    try {
      expect(ignored(path, lstatSync(path))).toBe(false);
    } finally {
      await watching.close();
    }
  });
});
