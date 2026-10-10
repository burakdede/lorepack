import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';

/**
 * `lorepack pack --verify` on an archive someone else made (#567), through the real binary.
 *
 * Memory is the property under test, and only a separate process can report its own peak, so
 * each run preloads a module that writes `process.resourceUsage().maxRSS` on exit.
 */
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const execute = promisify(execFile);

/** Peak resident memory allowed for verifying any archive. Node and the CLI take about 100 MB. */
const RSS_CEILING = 256 * 1024 * 1024;

const MANIFEST = new TextEncoder().encode('{"buildId":"lore_test"}\n');
const DATABASE = new TextEncoder().encode('SQLite format 3');

interface Measured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly peakRss: number;
}

async function verifyMeasured(root: string, archive: string): Promise<Measured> {
  const preload = join(root, 'peak-rss.mjs');
  const out = join(root, 'peak-rss.txt');
  writeFileSync(
    preload,
    "import { writeFileSync } from 'node:fs';\n" +
      "process.on('exit', () => writeFileSync(process.env.PEAK_RSS_OUT, String(process.resourceUsage().maxRSS * 1024)));\n",
  );
  let result: Omit<Measured, 'peakRss'>;
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      ['--import', pathToFileURL(preload).href, BIN, 'pack', '--verify', archive],
      { cwd: root, env: { ...process.env, PEAK_RSS_OUT: out }, timeout: 120_000 },
    );
    result = { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    result = {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
  return { ...result, peakRss: Number(readFileSync(out, 'utf8')) };
}

type Source = Uint8Array | { readonly stream: () => Readable; readonly size: number };

async function writeZip(path: string, members: ReadonlyArray<readonly [string, Source]>) {
  const zip = new yazl.ZipFile();
  for (const [name, source] of members) {
    if (source instanceof Uint8Array) zip.addBuffer(Buffer.from(source), name);
    else zip.addReadStream(source.stream(), name, { size: source.size });
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

function indexOf(digests: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ formatVersion: 1, algorithm: 'sha256', members: digests })}\n`,
  );
}

/** The uncompressed size a member declares in the central directory. See archive.test.ts. */
function declareSize(path: string, member: string, size: number): void {
  const bytes = readFileSync(path);
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.toString('utf8', offset + 46, offset + 46 + nameLength) === member) {
      bytes.writeUInt32LE(size, offset + 24);
    }
  }
  writeFileSync(path, bytes);
}

const MiB = 1024 * 1024;

function zeros(megabytes: number): { stream: () => Readable; size: number } {
  const chunk = Buffer.alloc(MiB);
  return {
    size: megabytes * MiB,
    stream: () =>
      Readable.from(
        (function* () {
          for (let index = 0; index < megabytes; index += 1) yield chunk;
        })(),
      ),
  };
}

describe('lorepack pack --verify on a hostile archive', () => {
  it('has been built, which the rest of this suite depends on', () => {
    expect(existsSync(BIN), `${BIN} is missing. Run \`pnpm build\` first.`).toBe(true);
  });

  it('refuses a decompression bomb with a typed limit error and flat memory', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'bomb.lorepack');
      const bombs = ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'];
      const payload = new Uint8Array(1024);
      await writeZip(archive, [
        ['manifest.json', MANIFEST],
        [
          'checksums.json',
          indexOf({
            'manifest.json': sha256Hex(MANIFEST),
            ...Object.fromEntries(bombs.map((name) => [name, sha256Hex(payload)])),
          }),
        ],
        ...bombs.map((name) => [name, payload] as const),
      ]);
      // Close to 4 GiB each, 20 GiB in all: what three 1 GiB members of zeros declared in the
      // original report, scaled past the default total.
      for (const name of bombs) declareSize(archive, name, 0xfffffff0);

      const result = await verifyMeasured(project.root, archive);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_LIMIT_EXCEEDED');
      expect(result.peakRss).toBeLessThan(RSS_CEILING);
    });
  }, 120_000);

  it('hashes a large listed member as a stream rather than buffering it', async () => {
    // 512 MiB of zeros compresses to about half a megabyte. Buffering it, as verification did
    // before #567, needs at least twice that in memory; streaming needs one chunk.
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'large.lorepack');
      const large = zeros(512);
      const hash = createHash('sha256');
      for await (const chunk of large.stream()) hash.update(chunk as Buffer);
      await writeZip(archive, [
        ['manifest.json', MANIFEST],
        [
          'checksums.json',
          indexOf({
            'manifest.json': sha256Hex(MANIFEST),
            'context.sqlite': sha256Hex(DATABASE),
            'objects/large.bin': hash.digest('hex'),
          }),
        ],
        ['context.sqlite', DATABASE],
        ['objects/large.bin', large],
      ]);

      const result = await verifyMeasured(project.root, archive);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('intact');
      expect(result.peakRss).toBeLessThan(RSS_CEILING);
    });
  }, 120_000);

  it('fails members named after Object.prototype keys as unlisted', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'extra.lorepack');
      const smuggled = new TextEncoder().encode('smuggled');
      await writeZip(archive, [
        ['manifest.json', MANIFEST],
        ['checksums.json', indexOf({ 'manifest.json': sha256Hex(MANIFEST) })],
        ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].map(
          (name) => [name, smuggled] as const,
        ),
      ]);

      const result = await verifyMeasured(project.root, archive);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('LORE_E_OBJECT_CORRUPT');
      expect(result.stderr).toContain('constructor is unlisted');
    });
  }, 120_000);
});
