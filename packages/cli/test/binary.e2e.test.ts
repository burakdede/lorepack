import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * Drives the real binary as a subprocess rather than the exported functions.
 *
 * The working agreement asks for end-to-end tests that assert exit codes and output, not
 * internal APIs. Everything here would still pass if the in-process tests were lying about
 * how the program behaves when Node actually starts it.
 */
const BIN = join(import.meta.dirname, '..', 'dist', 'bin', 'lore.js');

interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function lore(args: readonly string[]): Promise<Executed> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

// The binary only exists after a build. Skipping silently would make a broken build look
// like a passing suite, so the absence is asserted instead.
describe('lore binary', () => {
  it('has been built, which the rest of this suite depends on', () => {
    expect(
      existsSync(BIN),
      `${BIN} is missing. Run \`pnpm build\` before the end-to-end tests.`,
    ).toBe(true);
  });

  it('prints help and exits 0', async () => {
    const result = await lore(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: lore');
  });

  it('prints a version and exits 0', async () => {
    const result = await lore(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 1 with an actionable error for an unknown command', async () => {
    const result = await lore(['definitely-not-a-command']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('LORE_E_INVALID_ARGUMENT');
    expect(result.stderr).toContain('lore --help');
  });

  it('prints a failure exactly once', async () => {
    // Commander writes its own error before throwing; the central handler renders it too.
    // Without suppressing the first, every argument error appeared twice.
    const result = await lore(['definitely-not-a-command']);
    const occurrences = result.stderr.split('definitely-not-a-command').length - 1;
    expect(occurrences).toBe(1);
  });

  it('renders an argument error as JSON when asked', async () => {
    const result = await lore(['--json', 'definitely-not-a-command']);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe('LORE_E_INVALID_ARGUMENT');
  });

  it('starts on this Node version, so the engine guard admits a supported runtime', async () => {
    const result = await lore(['--help']);
    expect(result.stderr).not.toContain('LORE_E_UNSUPPORTED_NODE');
    expect(result.code).toBe(0);
  });
});
