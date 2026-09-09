import type { BuildId, LoadedConfig } from '@lorepack/core';
import { describe, expect, it, vi } from 'vitest';
import { type ServingDependencies, startServing } from '../src/services/serving.js';

const BUILD_ID = `lore_${'a'.repeat(64)}` as BuildId;
const CONFIG = {
  projectRoot: '/tmp/lorepack-serving-startup',
  config: { name: 'demo' },
} as LoadedConfig;

describe('serving startup cleanup', () => {
  it('closes the backend when binding every port fails', async () => {
    const close = vi.fn();
    const backend = {
      provider: { current: async () => ({ buildId: BUILD_ID, generation: 1 }) },
      close,
    } as unknown as ReturnType<NonNullable<ServingDependencies['createBackend']>>;
    const dependencies: ServingDependencies = {
      createBackend: vi.fn(() => backend),
      listen: vi.fn(async () => {
        throw new Error('no free port');
      }),
    };

    await expect(
      startServing({ config: CONFIG, host: '127.0.0.1', port: 4321, warn: vi.fn() }, dependencies),
    ).rejects.toThrow('no free port');
    expect(close).toHaveBeenCalledOnce();
  });
});
