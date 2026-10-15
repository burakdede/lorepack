import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  objects: new Set<string>(),
  commands: [] as string[][],
  requests: [] as { method: string; url: string }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_binary: string, args: string[]) => {
      const command = args.slice(1);
      remote.commands.push(command);
      if (
        command.slice(0, 3).join(' ') === 'r2 object delete' &&
        command[3]?.startsWith('owned-test-objects/') &&
        command[4] === '--remote'
      ) {
        expect(remote.objects.delete(command[3].slice('owned-test-objects/'.length))).toBe(true);
        return { stdout: '', stderr: '' };
      }
      if (command.join(' ') !== 'r2 bucket delete owned-test-objects') {
        throw new Error(`Unexpected command: ${command.join(' ')}`);
      }
      if (remote.objects.size > 0) {
        throw Object.assign(new Error('Bucket is not empty'), {
          code: 1,
          stderr: 'Bucket is not empty [code: 10008]',
        });
      }
      return { stdout: '', stderr: '' };
    },
  });
  return { ...original, execFile };
});

import { deleteCloudflareBucket } from '../src/cloudflare-smoke.js';

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-token' };
const OBJECTS_URL =
  'https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/owned-test-objects/objects';

describe('owned acceptance bucket cleanup, issue 622', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('LORE_CF_ARTIFACT_DIR', '');
    remote.objects.clear();
    remote.commands.length = 0;
    remote.requests.length = 0;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      remote.requests.push({ method, url: url.href });
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      if (method === 'GET' && `${url.origin}${url.pathname}` === OBJECTS_URL) {
        return Response.json({
          success: true,
          result: [...remote.objects].map((key) => ({ key })),
          result_info: { is_truncated: false },
        });
      }
      throw new Error(`Unexpected remote request: ${method} ${url.href}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('drains uploaded objects before deleting a nonempty bucket', async () => {
    remote.objects.add('folder/a b%#.json');
    remote.objects.add('folder/a/b.txt');
    const result = deleteCloudflareBucket('owned-test-objects', ENV).then(
      () => ({ success: true }),
      (error: unknown) => ({ success: false, error }),
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ success: true });
    expect(remote.objects.size).toBe(0);
    expect(remote.commands).toEqual([
      ['r2', 'object', 'delete', 'owned-test-objects/folder/a b%#.json', '--remote'],
      ['r2', 'object', 'delete', 'owned-test-objects/folder/a/b.txt', '--remote'],
      ['r2', 'bucket', 'delete', 'owned-test-objects'],
    ]);
  });

  it('still deletes an already empty owned bucket', async () => {
    await deleteCloudflareBucket('owned-test-objects', ENV);
    expect(remote.commands).toEqual([['r2', 'bucket', 'delete', 'owned-test-objects']]);
  });

  it('reads every page before deleting any of the listed objects', async () => {
    remote.objects.add('first');
    remote.objects.add('second');
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [{ key: 'first' }],
          result_info: { is_truncated: true, cursor: 'next/+=' },
        }),
      )
      .mockImplementationOnce(() => {
        expect(remote.commands).toEqual([]);
        return Promise.resolve(
          Response.json({
            success: true,
            result: [{ key: 'second' }],
            result_info: { is_truncated: false },
          }),
        );
      });
    vi.stubGlobal('fetch', request);
    await deleteCloudflareBucket('owned-test-objects', ENV);
    expect(new URL(request.mock.calls[1]?.[0]).searchParams.get('cursor')).toBe('next/+=');
    expect(remote.objects.size).toBe(0);
    expect(remote.commands.at(-1)).toEqual(['r2', 'bucket', 'delete', 'owned-test-objects']);
  });

  it('does not delete objects or the bucket when listing fails', async () => {
    remote.objects.add('retained');
    vi.stubGlobal('fetch', async () =>
      Response.json(
        { success: false, errors: [{ code: 10500, message: 'Internal error' }] },
        { status: 500 },
      ),
    );
    await expect(deleteCloudflareBucket('owned-test-objects', ENV)).rejects.toThrow(
      'Internal error [code: 10500]',
    );
    expect(remote.objects.has('retained')).toBe(true);
    expect(remote.commands).toEqual([]);
  });

  it.each([undefined, 'repeated'])('refuses invalid pagination cursor %s', async (cursor) => {
    remote.objects.add('retained');
    vi.stubGlobal('fetch', async () =>
      Response.json({
        success: true,
        result: [{ key: 'retained' }],
        result_info: { is_truncated: true, cursor },
      }),
    );
    await expect(deleteCloudflareBucket('owned-test-objects', ENV)).rejects.toThrow(
      'missing or repeated cursor',
    );
    expect(remote.objects.has('retained')).toBe(true);
    expect(remote.commands).toEqual([]);
  });
});
