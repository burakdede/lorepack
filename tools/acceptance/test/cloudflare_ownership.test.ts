import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  buckets: new Map<string, Map<string, string>>(),
  databases: new Set<string>(),
  workers: new Set<string>(),
  commands: [] as string[][],
  deletions: [] as string[],
  failUpload: false,
  failDatabase: null as string | null,
  invalidListing: null as 'worker' | 'd1' | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (
      _binary: string,
      args: string[],
      options: { env: Record<string, string> },
    ) => {
      expect(options.env.CLOUDFLARE_ACCOUNT_ID).toBe('test-account');
      const command = args.slice(1);
      remote.commands.push(command);
      const output = (value = '') => ({ stdout: value, stderr: '' });
      const fail = (message: string): never => {
        throw Object.assign(new Error(message), { code: 1, stderr: message });
      };
      const kind = command.slice(0, 3).join(' ');
      if (kind === 'd1 list --json') {
        if (remote.invalidListing === 'd1') return output('{}');
        return output(JSON.stringify([...remote.databases].map((name) => ({ name, id: name }))));
      }
      if (command[0] === 'd1' && command[1] === 'delete') {
        const name = command[2] ?? '';
        if (remote.failDatabase === name) return fail('D1 delete failed');
        remote.deletions.push(`d1:${name}`);
        if (!remote.databases.delete(name)) {
          return fail("Couldn't find a D1 DB with name or binding");
        }
        return output();
      }
      if (kind === 'r2 bucket create') {
        remote.buckets.set(command[3] ?? '', new Map());
        return output();
      }
      if (kind === 'r2 bucket delete') {
        const name = command[3] ?? '';
        const bucket = remote.buckets.get(name);
        if (bucket === undefined) return fail('The specified bucket does not exist. [code: 10006]');
        if (bucket.size > 0) return fail('Bucket is not empty [code: 10008]');
        remote.deletions.push(`bucket:${name}`);
        remote.buckets.delete(name);
        return output();
      }
      if (kind === 'r2 object put' || kind === 'r2 object delete') {
        const path = command[3] ?? '';
        const slash = path.indexOf('/');
        const name = path.slice(0, slash);
        const key = path.slice(slash + 1);
        const bucket = remote.buckets.get(name);
        if (bucket === undefined) return fail('The specified bucket does not exist. [code: 10006]');
        if (kind === 'r2 object put') {
          if (remote.failUpload) return fail('Ownership upload failed');
          const file = command[command.indexOf('--file') + 1];
          if (file === undefined) throw new Error('Missing ownership file');
          bucket.set(key, readFileSync(file, 'utf8'));
        } else {
          remote.deletions.push(`object:${path}`);
          bucket.delete(key);
        }
        return output();
      }
      throw new Error(`Unexpected Wrangler command: ${command.join(' ')}`);
    },
  });
  return { ...original, execFile };
});

import {
  type CloudflareOwnershipRecord,
  cloudflareOwnershipKey,
  cloudflareOwnershipNames,
  readCloudflareOwnershipRecord,
} from '../src/cloudflare_ownership.js';
import {
  addCloudflareCleanupProbe,
  cleanupOwnedCloudflareResources,
  cloudflareOwnershipBucketName,
  provisionCloudflareSmokeTarget,
  teardownCloudflareSmokeTarget,
} from '../src/cloudflare-smoke.js';

const SCOPE = {
  accountId: 'test-account',
  testPrefix: 'lorepack-ci',
  runId: '101',
  runAttempt: '2',
};
const ENV = {
  CLOUDFLARE_ACCOUNT_ID: SCOPE.accountId,
  CLOUDFLARE_API_TOKEN: 'fake-token',
  LORE_CF_TEST_PREFIX: SCOPE.testPrefix,
  GITHUB_RUN_ID: SCOPE.runId,
  GITHUB_RUN_ATTEMPT: SCOPE.runAttempt,
};
const LEDGER = cloudflareOwnershipBucketName(SCOPE);
const PROJECT = `lpci-${'a'.repeat(32)}`;
const R2_PATH = '/client/v4/accounts/test-account/r2/buckets/';

function record(letter: string, runId: string | null, runAttempt: string | null) {
  return readCloudflareOwnershipRecord(
    { ...SCOPE, formatVersion: 1, projectName: `lpci-${letter.repeat(32)}`, runId, runAttempt },
    SCOPE,
  );
}

function seed(value: CloudflareOwnershipRecord, contents = true): void {
  remote.buckets.get(LEDGER)?.set(cloudflareOwnershipKey(value), JSON.stringify(value));
  if (!contents) return;
  const names = cloudflareOwnershipNames(value);
  remote.databases.add(names.catalogDatabaseName);
  remote.databases.add(names.tablesDatabaseName);
  remote.buckets.set(names.objectsBucketName, new Map([['retained/object', 'body']]));
}

describe('durable Cloudflare acceptance ownership, issue 622', () => {
  beforeEach(() => {
    remote.buckets.clear();
    remote.buckets.set(LEDGER, new Map());
    remote.databases.clear();
    remote.workers.clear();
    remote.commands.length = 0;
    remote.deletions.length = 0;
    remote.failUpload = false;
    remote.failDatabase = null;
    remote.invalidListing = null;
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.stubEnv('LORE_CF_ARTIFACT_DIR', '');
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-token');
      const workerPath = '/client/v4/accounts/test-account/workers/scripts';
      if (method === 'GET' && url.pathname === workerPath) {
        if (remote.invalidListing === 'worker') return Response.json({ success: false });
        return Response.json({
          success: true,
          result: [...remote.workers].map((name) => ({ id: name })),
        });
      }
      if (method === 'DELETE' && url.pathname.startsWith(`${workerPath}/`)) {
        const name = decodeURIComponent(url.pathname.slice(workerPath.length + 1));
        remote.deletions.push(`worker:${name}`);
        const existed = remote.workers.delete(name);
        return new Response(null, { status: existed ? 204 : 404 });
      }
      if (!url.pathname.startsWith(R2_PATH) || method !== 'GET') {
        throw new Error(`Unexpected Cloudflare request: ${method} ${url.href}`);
      }
      const parts = url.pathname.slice(R2_PATH.length).split('/');
      const name = decodeURIComponent(parts[0] ?? '');
      const bucket = remote.buckets.get(name);
      if (bucket === undefined) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10006, message: 'The specified bucket does not exist.' }],
          },
          { status: 404 },
        );
      }
      if (parts.length === 1) return Response.json({ success: true, result: { name } });
      if (parts[1] !== 'objects') throw new Error(`Unexpected object path: ${url.href}`);
      if (parts.length === 2) {
        const prefix = url.searchParams.get('prefix') ?? '';
        return Response.json({
          success: true,
          result: [...bucket.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key })),
          result_info: { is_truncated: false },
        });
      }
      const value = bucket.get(decodeURIComponent(parts.slice(2).join('/')));
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('records unused names durably before returning a target to the CLI caller', async () => {
    remote.buckets.delete(LEDGER);
    const target = await provisionCloudflareSmokeTarget(PROJECT);
    const stored = remote.buckets.get(LEDGER)?.get(cloudflareOwnershipKey(target.ownership));
    expect(stored).toBeDefined();
    expect(JSON.parse(stored ?? '')).toEqual({ ...SCOPE, formatVersion: 1, projectName: PROJECT });
    expect(stored).not.toContain('fake-token');
    expect(remote.databases.size).toBe(0);
    expect(remote.buckets.has(target.objectsBucketName)).toBe(false);
    expect(remote.deletions).toEqual([]);
  });

  it('refuses to claim names that already exist', async () => {
    remote.databases.add(`${PROJECT}-tables`);
    await expect(provisionCloudflareSmokeTarget(PROJECT).then(() => undefined)).rejects.toThrow(
      'existing Cloudflare resources',
    );
    expect(remote.buckets.get(LEDGER)?.size).toBe(0);
    expect(remote.databases.has(`${PROJECT}-tables`)).toBe(true);
    expect(remote.deletions).toEqual([]);
  });

  it('writes a real ownership artifact before the caller can provision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lore-ownership-artifact-'));
    try {
      vi.stubEnv('LORE_CF_ARTIFACT_DIR', directory);
      const target = await provisionCloudflareSmokeTarget(PROJECT);
      const body = readFileSync(join(directory, PROJECT, 'ownership-record.json'), 'utf8');
      expect(JSON.parse(body)).toEqual(target.ownership);
      expect(body).not.toContain('fake-token');
      expect(remote.databases.size).toBe(0);
      const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
      expect(files.every((name) => Buffer.byteLength(name) <= 255)).toBe(true);
      const logs = files.map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
      expect(
        logs.some((log: { args: string[] }) =>
          log.args.includes(`${LEDGER}/${cloudflareOwnershipKey(target.ownership)}`),
        ),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not return a provisionable target if recording ownership fails', async () => {
    remote.failUpload = true;
    await expect(provisionCloudflareSmokeTarget(PROJECT).then(() => undefined)).rejects.toThrow(
      'Ownership upload failed',
    );
    expect(remote.databases.size).toBe(0);
    expect(remote.buckets.get(LEDGER)?.size).toBe(0);
  });

  it.each(['worker', 'd1'] as const)(
    'refuses to infer unused names from an invalid %s listing',
    async (kind) => {
      remote.invalidListing = kind;
      if (kind === 'worker') remote.workers.add(`${PROJECT}-runtime`);
      else remote.databases.add(`${PROJECT}-tables`);
      await expect(provisionCloudflareSmokeTarget(PROJECT).then(() => undefined)).rejects.toThrow(
        'listing',
      );
      expect(remote.buckets.get(LEDGER)?.size).toBe(0);
      expect(remote.deletions).toEqual([]);
    },
  );

  it.each(['before provisioning', 'after one database', 'after uploading objects'])(
    'recovers an owned crashed run %s without adopting production resources',
    async (crash) => {
      const old = record('a', '100', '1');
      seed(old, false);
      const names = cloudflareOwnershipNames(old);
      if (crash !== 'before provisioning') remote.databases.add(names.catalogDatabaseName);
      if (crash === 'after uploading objects') {
        remote.databases.add(names.tablesDatabaseName);
        remote.buckets.set(names.objectsBucketName, new Map([['unexpected/key', 'body']]));
      }
      const production = 'lorepack-2026-10-product-research';
      remote.databases.add(`${production}-catalog`);
      remote.databases.add(`${production}-tables`);
      remote.buckets.set(`${production}-objects`, new Map([['important', 'retain']]));
      remote.workers.add(`${production}-runtime`);
      remote.workers.add('lorepack-ci-acceptance-runtime');
      await cleanupOwnedCloudflareResources(SCOPE, ENV);
      expect(remote.buckets.get(LEDGER)?.size).toBe(0);
      expect(remote.databases.has(names.catalogDatabaseName)).toBe(false);
      expect(remote.databases.has(names.tablesDatabaseName)).toBe(false);
      expect(remote.buckets.has(names.objectsBucketName)).toBe(false);
      expect([...remote.databases]).toEqual([`${production}-catalog`, `${production}-tables`]);
      expect(remote.buckets.get(`${production}-objects`)?.get('important')).toBe('retain');
      expect([...remote.workers]).toEqual([
        `${production}-runtime`,
        'lorepack-ci-acceptance-runtime',
      ]);
      expect(remote.deletions.some((entry) => entry.includes(production))).toBe(false);
    },
  );

  it('retains current, future and manual run ownership records and resources', async () => {
    const records = [record('a', '101', '2'), record('b', '102', '1'), record('c', null, null)];
    for (const value of records) seed(value);
    await cleanupOwnedCloudflareResources(SCOPE, ENV);
    expect(remote.buckets.get(LEDGER)?.size).toBe(3);
    expect(remote.databases.size).toBe(6);
    expect(remote.deletions).toEqual([]);
  });

  it('recovers earlier attempts of the same CI run', async () => {
    seed(record('a', '101', '1'));
    await cleanupOwnedCloudflareResources(SCOPE, ENV);
    expect(remote.buckets.get(LEDGER)?.size).toBe(0);
    expect(remote.databases.size).toBe(0);
  });

  it('retains the journal when any owned resource deletion fails', async () => {
    const old = record('a', '100', '1');
    seed(old);
    remote.failDatabase = cloudflareOwnershipNames(old).tablesDatabaseName;
    await expect(cleanupOwnedCloudflareResources(SCOPE, ENV)).rejects.toThrow('D1 delete failed');
    expect(remote.buckets.get(LEDGER)?.has(cloudflareOwnershipKey(old))).toBe(true);
    expect(remote.databases.has(remote.failDatabase)).toBe(true);
    remote.failDatabase = null;
    await cleanupOwnedCloudflareResources(SCOPE, ENV);
    expect(remote.buckets.get(LEDGER)?.size).toBe(0);
    expect(remote.databases.size).toBe(0);
  });

  it.each([
    { accountId: 'other-account' },
    { testPrefix: 'other-prefix' },
    { formatVersion: 2 },
    { projectName: 'lorepack-2026-10-product-research' },
    { runId: 'not-a-run' },
  ])('refuses an invalid record before deleting anything: %j', async (change) => {
    const old = record('a', '100', '1');
    seed(old);
    remote.buckets
      .get(LEDGER)
      ?.set(cloudflareOwnershipKey(old), JSON.stringify({ ...old, ...change }));
    await expect(cleanupOwnedCloudflareResources(SCOPE, ENV)).rejects.toThrow('ownership record');
    expect(remote.deletions).toEqual([]);
    expect(remote.databases.size).toBe(2);
  });

  it('refuses to access another account even when the caller supplies a valid record', async () => {
    seed(record('a', '100', '1'));
    await expect(
      cleanupOwnedCloudflareResources({ ...SCOPE, accountId: 'other-account' }, ENV),
    ).rejects.toThrow('account does not match');
    expect(remote.commands).toEqual([]);
    expect(remote.deletions).toEqual([]);
  });

  it('refuses a caller-supplied future run that does not match the environment', async () => {
    seed(record('a', '101', '2'));
    await expect(cleanupOwnedCloudflareResources({ ...SCOPE, runId: '999' }, ENV)).rejects.toThrow(
      'scope does not match the current environment',
    );
    expect(remote.commands).toEqual([]);
    expect(remote.deletions).toEqual([]);
  });

  it('validates all journal records before deleting any owned resource', async () => {
    seed(record('a', '100', '1'));
    remote.buckets.get(LEDGER)?.set(`ownership/v1/lpci-${'b'.repeat(32)}.json`, 'not-json');
    await expect(cleanupOwnedCloudflareResources(SCOPE, ENV)).rejects.toThrow('not valid JSON');
    expect(remote.databases.size).toBe(2);
    expect(remote.deletions).toEqual([]);
  });

  it('binds record content to its canonical object key', async () => {
    const old = record('a', '100', '1');
    seed(old);
    remote.buckets
      .get(LEDGER)
      ?.set(cloudflareOwnershipKey(old), JSON.stringify(record('b', '100', '1')));
    await expect(cleanupOwnedCloudflareResources(SCOPE, ENV)).rejects.toThrow(
      'does not match its stored key',
    );
    expect(remote.deletions).toEqual([]);
  });

  it('verifies the stored ownership before tearing down a live target', async () => {
    const target = await provisionCloudflareSmokeTarget(PROJECT);
    seed(target.ownership);
    remote.workers.add(target.workerName);
    remote.workers.add(`${PROJECT}-runtime`);
    await addCloudflareCleanupProbe(target);
    expect(remote.buckets.get(target.objectsBucketName)?.get('acceptance-cleanup-probe')).toBe(
      'Owned acceptance cleanup probe.\n',
    );
    await expect(
      teardownCloudflareSmokeTarget(
        { ...target, tablesDatabaseName: 'production-tables' },
        PROJECT,
        '/not-used',
        [],
      ),
    ).rejects.toThrow('does not match its recorded ownership');
    expect(remote.deletions).toEqual([]);
    await teardownCloudflareSmokeTarget(target, PROJECT, '/not-used', []);
    expect(remote.buckets.get(LEDGER)?.size).toBe(0);
    expect(remote.databases.size).toBe(0);
    expect(remote.workers.size).toBe(0);
  });
});
