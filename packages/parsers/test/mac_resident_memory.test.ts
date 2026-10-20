import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseMacResidentMemory, readMacResidentMemory } from '../src/resident_memory.js';

const readers: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];

function reportProcess(program: string, timeout?: number) {
  const child = spawn(
    process.execPath,
    ['-e', program],
    timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' },
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  readers.push({ child, closed });
  return { child, result: readMacResidentMemory(child) };
}

afterEach(async () => {
  for (const { child, closed } of readers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});

it.each([
  ['312', 312 * 1024],
  ['  312\n', 312 * 1024],
  ['0\n', 0],
] as const)('reads macOS resident bytes from %j', (report, bytes) => {
  expect(parseMacResidentMemory(report)).toBe(bytes);
});

it.each(['', ' \n', '-', '-1', '12\n13', '12 kB', 'unknown'])(
  'rejects malformed macOS RSS %j',
  (report) => {
    expect(() => parseMacResidentMemory(report)).toThrow(
      `macOS did not report parser resident memory: ${JSON.stringify(report)}.`,
    );
  },
);

it('drains a real process report through close, including zero', async () => {
  for (const [text, bytes] of [
    ['312\n', 312 * 1024],
    ['0\n', 0],
    [`${'0'.repeat(255)}\n`, 0],
  ] as const) {
    const { result } = reportProcess(`process.stdout.end(${JSON.stringify(text)})`);
    await expect(result).resolves.toBe(bytes);
  }
});

it.each(['', 'unknown\n'])('still rejects a real empty or malformed report %j', async (text) => {
  const { result } = reportProcess(`process.stdout.end(${JSON.stringify(text)})`);
  await expect(result).rejects.toThrow('macOS did not report parser resident memory:');
});

it.each(['stdout', 'stderr'] as const)('bounds actual %s output at 256 bytes', async (stream) => {
  const { child, result } = reportProcess(
    `process.${stream}.write('x'.repeat(257)); setInterval(() => {}, 1000)`,
  );
  await expect(result).rejects.toThrow(`macOS resident-memory ${stream} exceeded 256 bytes.`);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
});

it('rejects a real nonzero reader exit even with numeric output', async () => {
  const { result } = reportProcess("process.stdout.write('312\\n'); process.exitCode = 17");
  await expect(result).rejects.toThrow(
    'macOS resident-memory reader exited (17); stdout "312\\n"; stderr "".',
  );
});

it('still terminates a genuinely hung reader at the original timeout', async () => {
  const { result } = reportProcess('setInterval(() => {}, 1000)', 250);
  await expect(result).rejects.toThrow('macOS resident-memory reader exited (');
});

it('retains a complete RSS line when the reader is killed before close', async () => {
  const { result } = reportProcess(
    "process.stdout.write('312\\n'); setInterval(() => {}, 1000)",
    250,
  );
  await expect(result).rejects.toThrow('stdout "312\\n"');
});

it('counts real UTF-8 output in bytes rather than characters', async () => {
  const { result } = reportProcess("process.stdout.end('é'.repeat(129))");
  await expect(result).rejects.toThrow('macOS resident-memory stdout exceeded 256 bytes.');
});

it('preserves an actual reader spawn failure', async () => {
  const child = spawn(join(tmpdir(), `missing-rss-reader-${randomUUID()}`), []);
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  readers.push({ child, closed });
  await expect(readMacResidentMemory(child)).rejects.toMatchObject({ code: 'ENOENT' });
});
