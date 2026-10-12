import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileObjectStore } from '../src/object-store.js';

let directory: string;
let root: string;
let store: FileObjectStore;
const bytes = new TextEncoder().encode('retained object bytes');
const pathFor = (hash: string) =>
  join(root, 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lorepack-object-verify-'));
  root = join(directory, 'objects');
  store = new FileObjectStore(root);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('streaming object verification', () => {
  it('verifies a multi-chunk object without changing its bytes', async () => {
    const data = new Uint8Array(192 * 1024 + 17);
    for (let index = 0; index < data.length; index++) data[index] = index % 251;
    const hash = await store.put(data);
    expect(await store.verify(hash)).toBe(true);
    expect(new Uint8Array(readFileSync(pathFor(hash)))).toEqual(data);
  });
  it('returns false for an absent object without creating the store', async () => {
    expect(await store.verify('f'.repeat(64))).toBe(false);
    expect(existsSync(root)).toBe(false);
  });
  it('refuses changed bytes and preserves the corrupt object for recovery', async () => {
    const hash = await store.put(bytes);
    const path = pathFor(hash);
    writeFileSync(path, 'changed bytes');
    await expect(store.verify(hash)).rejects.toMatchObject({
      code: 'LORE_E_OBJECT_CORRUPT',
      subject: hash,
      message: `Object ${hash} failed its checksum.`,
      remediation: 'Restore the retained object from a verified package.',
    });
    expect(readFileSync(path, 'utf8')).toBe('changed bytes');
  });
  it('propagates cancellation without removing or rewriting the object', async () => {
    const hash = await store.put(bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(store.verify(hash, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    expect(new Uint8Array(readFileSync(pathFor(hash)))).toEqual(bytes);
    expect(await store.verify(hash)).toBe(true);
  });
  it.each(['../outside.txt', 'F'.repeat(64), 'f'.repeat(63), 'g'.repeat(64), ''])(
    'rejects invalid hash %s without creating storage',
    async (hash) => {
      const outside = join(directory, 'outside.txt');
      writeFileSync(outside, 'private outside bytes');
      await expect(store.verify(hash)).rejects.toMatchObject({
        code: 'LORE_E_INVALID_ARGUMENT',
        subject: hash,
      });
      expect(readFileSync(outside, 'utf8')).toBe('private outside bytes');
      expect(existsSync(root)).toBe(false);
    },
  );
});
