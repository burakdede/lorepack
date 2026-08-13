import * as net from 'node:net';
import { registerCommands, runCli } from '@lorepack/cli';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';

class Capture {
  text = '';

  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}

async function runLore(
  argv: readonly string[],
  cwd: string,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(['node', 'lore', '--cwd', cwd, ...argv], {
    commands: registerCommands(),
    exitProcess: false,
    streams: {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      isTty: false,
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function blockNetwork(): { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const fail = (name: string): never => {
    calls.push(name);
    throw new Error(`network call blocked: ${name}`);
  };

  vi.stubGlobal('fetch', () => fail('fetch'));
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => fail('socket.connect'));

  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('privacy defaults: no telemetry or source egress in the build path', () => {
  it('builds offline with fetch and sockets blocked', async () => {
    const network = blockNetwork();
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: offline\nsources:\n  - .\n',
          'docs/runbook.md':
            '# Runbook\n\nA remote URL such as https://example.invalid/data must stay inert.\n',
          'docs/page.html':
            '<!doctype html><title>Offline</title><script>fetch("https://example.invalid")</script><p>Local only.</p>',
          'data/owners.csv': 'team,owner\nruntime,ops@example.test\n',
        },
      },
      async (project) => {
        const result = await runLore(['build'], project.root);

        expect(result.code).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/Build lore_[0-9a-f]{64}/);
        expect(network.calls).toEqual([]);
      },
    );
  });
});
