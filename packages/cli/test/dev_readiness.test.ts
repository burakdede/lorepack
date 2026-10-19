import { expect, it, vi } from 'vitest';
import { devCommand } from '../src/commands/dev.js';
import type { CommandContext } from '../src/framework/context.js';

const mocked = vi.hoisted(() => ({
  startWatching: vi.fn(),
  startServing: vi.fn(),
  untilInterrupted: vi.fn(),
}));

vi.mock('@lorepack/backend-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lorepack/backend-local')>()),
  assertFts5Available: () => undefined,
}));
vi.mock('@lorepack/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lorepack/core')>()),
  loadConfig: () => ({ projectRoot: '/project', config: { name: 'readiness' } }),
}));
vi.mock('../src/services/init.js', () => ({
  planInit: () => ({ alreadyInitialized: true }),
}));
vi.mock('../src/services/dev-session.js', () => ({
  DEV_PORT: 4321,
  assertNoLiveSession: () => undefined,
  writeReceipt: () => undefined,
  removeReceipt: () => undefined,
}));
vi.mock('../src/services/build.js', () => ({
  runBuild: async () => ({ buildId: 'lore_1234567890123456', reusedArtifacts: 0, warnings: 0 }),
}));
vi.mock('../src/services/background_build.js', () => ({ runBackgroundBuild: vi.fn() }));
vi.mock('../src/services/watch.js', () => ({ startWatching: mocked.startWatching }));
vi.mock('../src/services/serving.js', () => ({
  resolveDevPort: () => 4321,
  startServing: mocked.startServing,
  untilInterrupted: mocked.untilInterrupted,
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('announces a dev session only after its watcher is ready', async () => {
  vi.clearAllMocks();
  const ready = deferred();
  const stopped = deferred();
  const writes: string[] = [];
  mocked.startWatching.mockReturnValue({ ready: ready.promise, close: async () => undefined });
  mocked.startServing.mockResolvedValue({
    port: 4321,
    buildId: 'lore_1234567890123456',
    url: 'http://127.0.0.1:4321',
    studio: true,
    close: async () => undefined,
  });
  mocked.untilInterrupted.mockReturnValue(stopped.promise);

  const context = {
    options: { cwd: '/project' },
    progress: {},
    write: (text: string) => writes.push(text),
    warn: () => undefined,
  } as unknown as CommandContext;
  const running = devCommand().handler(['/project'], {}, context);
  try {
    await vi.waitFor(() => expect(mocked.startWatching).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocked.startServing).toHaveBeenCalledOnce());
    expect(writes).toEqual([]);
    ready.resolve();
    await vi.waitFor(() => expect(writes.join('')).toContain('MCP stdio'));
  } finally {
    ready.resolve();
    stopped.resolve();
    await running;
  }
});

it('drains a session interrupted before watcher readiness', async () => {
  vi.clearAllMocks();
  const ready = deferred();
  const stopped = deferred();
  const closeWatcher = vi.fn(async () => undefined);
  const closeServer = vi.fn(async () => undefined);
  const writes: string[] = [];
  mocked.startWatching.mockReturnValue({ ready: ready.promise, close: closeWatcher });
  mocked.startServing.mockResolvedValue({
    port: 4321,
    buildId: 'lore_1234567890123456',
    url: 'http://127.0.0.1:4321',
    studio: true,
    close: closeServer,
  });
  mocked.untilInterrupted.mockReturnValue(stopped.promise);

  const context = {
    options: { cwd: '/project' },
    progress: {},
    write: (text: string) => writes.push(text),
    warn: () => undefined,
  } as unknown as CommandContext;
  const running = devCommand().handler(['/project'], {}, context);
  await vi.waitFor(() => expect(mocked.startServing).toHaveBeenCalledOnce());
  stopped.resolve();
  try {
    await running;
    expect(writes).toEqual([]);
    expect(closeWatcher).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
  } finally {
    ready.resolve();
  }
});
