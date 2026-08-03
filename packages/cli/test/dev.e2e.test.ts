import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lore dev` as a person actually runs it: point it at a folder and expect a running runtime.
 *
 * Everything this command promises is invisible in process. Whether it validates before it
 * writes, whether the files it says it created exist, whether the URLs it prints answer, and
 * whether Ctrl-C leaves the build intact are all properties of a real process against a real
 * directory.
 */

const BINARY = join(import.meta.dirname, '..', 'dist', 'entry.js');
const DOCUMENT =
  '# Runbook\n\n## Rolling back\n\nRun `lore rollback` to return to the previous build.\n';

let project: string;
const running: ChildProcess[] = [];

/**
 * Whether a parent process can ask this child to stop *gracefully*.
 *
 * Windows has no POSIX signals. `child.kill('SIGTERM')` is emulated with `TerminateProcess`,
 * so the handler never runs, no matter which signal name is passed. A user pressing Ctrl-C
 * in their own console is unaffected: that path goes through a console control handler and
 * does reach the process.
 *
 * So graceful-shutdown assertions are POSIX-only, and the Windows behaviour is covered by
 * the case that actually happens there: a hard kill leaves a receipt naming a dead pid, and
 * the next session clears it. That is the whole reason the receipt is evidence rather than a
 * lock. #61 owns the general version of this.
 */
const CAN_SIGNAL_GRACEFULLY = platform() !== 'win32';

/** Ports well clear of the 4321 default, so a developer's own server cannot collide. */
let nextPort = 4700;

interface Started {
  readonly child: ChildProcess;
  readonly stdout: string;
  /** Live, so an assertion can quote what the supervisor said while it was failing. */
  readonly log: () => string;
  readonly stderr: string;
  readonly port: number;
}

/** Runs `lore dev` until it has printed its connection block, or fails loudly. */
async function dev(): Promise<Started> {
  nextPort += 1;
  const port = nextPort;
  const child = spawn(process.execPath, [BINARY, 'dev', project, '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const deadline = Date.now() + 90_000;
  while (!stdout.includes('MCP stdio') && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Asserted rather than returned quietly. A process that died during the build leaves an
  // empty stdout, and every "does not contain" assertion below would then pass by saying
  // nothing at all.
  expect(
    stdout,
    `lore dev never printed its connection block. stdout:\n${stdout}\nstderr:\n${stderr}`,
  ).toContain('MCP stdio');
  return { child, stdout, stderr, log: () => `stdout:\n${stdout}\n\nstderr:\n${stderr}`, port };
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-dev-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'runbook.md'), DOCUMENT, 'utf8');
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const give = setTimeout(resolve, 10_000);
        child.once('exit', () => {
          clearTimeout(give);
          resolve(undefined);
        });
      });
    }
  }
  try {
    // Windows holds the build database open a moment after the child exits, and a leaked
    // temporary directory must never fail a run that already passed its assertions.
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Nothing to do: the operating system will clean its own temp directory.
  }
});

describe('one command on an unconfigured folder', () => {
  it('creates the configuration, builds, activates and serves', async () => {
    const started = await dev();

    // Said what it wrote, and wrote exactly that.
    expect(started.stdout).toContain('Created:');
    for (const file of ['lore.yaml', '.loreignore', '.gitignore']) {
      expect(started.stdout, `${file} should be reported`).toContain(file);
      expect(existsSync(join(project, file)), `${file} should exist`).toBe(true);
    }

    expect(started.stdout).toMatch(/Build\s+lore_[0-9a-f]{12}/);
    expect(started.stdout).toContain('Reused          0 artifacts (first build)');
  }, 120_000);

  it('serves REST and MCP on the port it printed', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;

    expect(started.stdout).toContain(`HTTP            ${base}/v1`);
    expect(started.stdout).toContain(`MCP HTTP        ${base}/mcp`);

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const described = (await (await fetch(`${base}/v1/build`)).json()) as { buildId: string };
    expect(described.buildId).toMatch(/^lore_[0-9a-f]{64}$/);

    // The build it serves is the build it said it made.
    expect(started.stdout).toContain(described.buildId.slice(0, 17));
  }, 120_000);

  it('quotes the stdio command, so a path with a space stays one argument', async () => {
    const started = await dev();
    expect(started.stdout).toMatch(/MCP stdio {7}lore mcp --project "[^"]+"/);
  }, 120_000);

  /**
   * The 6.4 block names only what exists, which is the whole point of the assertion.
   *
   * This asserted `not.toContain('Studio')` from #53 until #64 built it, and the amendment on
   * #53 said the phase that adds the assets updates this line in the same change. That is
   * what happened. The `Connect now` list still names only `claude-code`, because Codex and
   * VS Code are Phase 5 and each arrives with the adapter that makes it true.
   */
  it('offers exactly what it has: Studio, and the one client with an adapter', async () => {
    const started = await dev();

    expect(started.stdout).toMatch(/Studio {10}http:\/\/127\.0\.0\.1:\d+/);
    expect(started.stdout).toContain('lore connect claude-code');
    expect(started.stdout).not.toContain('lore connect codex');
    expect(started.stdout).not.toContain('lore connect vscode');
  }, 120_000);

  it('serves Studio at the root without shadowing the API', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;

    // The app itself, and a hash route, which is any path that is not a file.
    expect((await fetch(base)).status).toBe(200);
    expect((await fetch(`${base}/sources`)).status).toBe(200);

    // The failure that mattered while wiring this: a single-page fallback that answers every
    // unmatched path will happily answer `/v1/nope` with the app shell and a 200, which
    // silently replaces the typed error contract with an HTML document.
    const missing = await fetch(`${base}/v1/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'LORE_E_INVALID_ARGUMENT',
    );
  }, 120_000);
});

describe('running it again', () => {
  it('skips init and reuses the artifacts it already compiled', async () => {
    const first = await dev();
    first.child.kill('SIGTERM');
    await new Promise((resolve) => first.child.once('exit', resolve));

    const configured = readFileSync(join(project, 'lore.yaml'), 'utf8');
    const second = await dev();

    expect(second.stdout).not.toContain('Created:');
    expect(second.stdout).not.toContain('(first build)');
    // Idempotent: the second run left the configuration exactly as the first wrote it.
    expect(readFileSync(join(project, 'lore.yaml'), 'utf8')).toBe(configured);
  }, 120_000);
});

describe('watching while it serves', () => {
  /**
   * The promise the command's name makes. Everything else here proves a step; this proves
   * the loop: a document changes on disk and the next question a client asks is answered
   * from a build that contains the change, with no restart and no client action.
   */
  it('rebuilds on an edit and serves the new content', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;
    const before = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string })
      .buildId;

    writeFileSync(
      join(project, 'docs', 'runbook.md'),
      `${DOCUMENT}\n## Freeze\n\nNo deployments during a change freeze.\n`,
      'utf8',
    );

    const deadline = Date.now() + 60_000;
    let after = before;
    while (after === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      // A poll that races a rebuild can have its connection reset, which is a fact about
      // hammering a socket rather than anything this test is about. Windows resets more
      // eagerly than Linux, so ignoring it here is what keeps the assertion about rebuilds.
      try {
        after = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string }).buildId;
      } catch {}
    }
    expect(
      after,
      `the edit should have produced a new build. The supervisor said:\n${started.log()}`,
    ).not.toBe(before);

    const found = (await (
      await fetch(`${base}/v1/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'freeze' }),
      })
    ).json()) as { hits: unknown[]; sourceState: string };

    expect(found.hits.length).toBeGreaterThan(0);
    // Freshness comes from the watcher now, and the watcher has just rebuilt.
    expect(found.sourceState).toBe('clean');
  }, 120_000);
});

/**
 * The lifecycle actions Studio drives, over the same HTTP the browser uses.
 *
 * The point of testing them here rather than in the component tests is that everything worth
 * doubting is outside the browser: whether the pointer actually moved, whether the server
 * still serving the old build notices, and whether a model asking a question through MCP
 * sees the same build a person sees in Studio (architecture 15.2).
 */
describe('changing which build is live, from Studio', () => {
  /** Edits a document and waits for the watcher to produce a second build. */
  async function rebuild(base: string, from: string): Promise<string> {
    writeFileSync(
      join(project, 'docs', 'runbook.md'),
      `${DOCUMENT}\n## Freeze\n\nNo deployments during a change freeze.\n`,
      'utf8',
    );
    const deadline = Date.now() + 60_000;
    let now = from;
    while (now === from && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        now = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string }).buildId;
      } catch {}
    }
    return now;
  }

  it('lists the history, rolls back, and every surface follows', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;
    const first = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string }).buildId;
    const second = await rebuild(base, first);
    expect(second, `the edit should have produced a second build.\n${started.log()}`).not.toBe(
      first,
    );

    const history = (await (await fetch(`${base}/v1/builds`)).json()) as {
      activeBuildId: string;
      builds: { buildId: string; state: string; capabilities: string[] | null }[];
    };
    expect(history.activeBuildId).toBe(second);
    expect(history.builds.map((build) => build.buildId)).toContain(first);
    expect(history.builds[0]?.capabilities).toContain('lexical-search');

    // The comparison of two real builds, neither of which is being re-read from source.
    const diff = (await (await fetch(`${base}/v1/builds/${first}/diff/${second}`)).json()) as {
      identical: boolean;
    };
    expect(diff.identical).toBe(false);

    const rolled = await fetch(`${base}/v1/builds/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect: first }),
    });
    expect(rolled.status).toBe(200);
    expect(((await rolled.json()) as { buildId: string }).buildId).toBe(first);

    // The pointer moved for everyone. Section 15.2: a handle is taken per request, so the
    // very next call observes the change without the server being restarted.
    const now = (await (await fetch(`${base}/v1/build`)).json()) as { buildId: string };
    expect(now.buildId).toBe(first);

    // And through MCP, which is the surface a model asks on. A tool call landing on the old
    // build after a person rolled back in Studio is the failure this asserts against.
    const call = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'lore_search', arguments: { query: 'freeze' } },
      }),
    });
    const text = await call.text();
    expect(text).toContain(first);
    // The rolled-back build predates the edit, so the term the second build introduced is
    // gone. This is the assertion that would catch a stale handle being reused.
    expect(text).not.toContain(second);
  }, 180_000);

  it('refuses a stale confirmation instead of acting on a different build', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;
    const first = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string }).buildId;
    await rebuild(base, first);

    const response = await fetch(`${base}/v1/builds/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect: `lore_${'0'.repeat(64)}` }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; remediation: string } };
    expect(body.error.code).toBe('LORE_E_INVALID_ARGUMENT');
    expect(body.error.remediation).toContain(first);
  }, 180_000);

  it('refuses these actions to any origin but this machine', async () => {
    const started = await dev();
    const base = `http://127.0.0.1:${started.port}`;

    const refused = await fetch(`${base}/v1/builds/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ build: `lore_${'0'.repeat(64)}` }),
    });
    expect(refused.status).toBe(403);

    // The same request from the page Studio actually is.
    const allowed = await fetch(`${base}/v1/builds`, {
      headers: { Origin: `http://127.0.0.1:${started.port}` },
    });
    expect(allowed.status).toBe(200);
  }, 120_000);
});

describe('shutting down', () => {
  it.runIf(CAN_SIGNAL_GRACEFULLY)(
    'stops on a signal and leaves the active build intact',
    async () => {
      const started = await dev();
      const base = `http://127.0.0.1:${started.port}`;
      const before = ((await (await fetch(`${base}/v1/build`)).json()) as { buildId: string })
        .buildId;

      started.child.kill('SIGTERM');
      const code = await new Promise<number>((resolve) => {
        const give = setTimeout(() => resolve(-1), 30_000);
        started.child.once('exit', (value) => {
          clearTimeout(give);
          resolve(value ?? 0);
        });
      });
      expect(code).toBe(0);

      // The pointer survived the shutdown, and no lock was left to block the next command.
      const after = spawn(process.execPath, [BINARY, '--cwd', project, 'status', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      after.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      const statusCode = await new Promise<number>((resolve) => {
        after.once('exit', (value) => resolve(value ?? 0));
      });

      expect(statusCode).toBe(0);
      expect((JSON.parse(out) as { activeBuildId: string }).activeBuildId).toBe(before);
    },
    120_000,
  );
});

describe('the session receipt', () => {
  it('records the running session', async () => {
    const started = await dev();
    const receipt = JSON.parse(readFileSync(join(project, '.lore', 'dev.json'), 'utf8')) as {
      port: number;
      pid: number;
      buildId: string;
      host: string;
    };

    expect(receipt.port).toBe(started.port);
    expect(receipt.pid).toBe(started.child.pid);
    expect(receipt.host).toBe('127.0.0.1');
    expect(receipt.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
  }, 120_000);

  it.runIf(CAN_SIGNAL_GRACEFULLY)(
    'removes the receipt on a clean stop',
    async () => {
      const started = await dev();
      const path = join(project, '.lore', 'dev.json');
      expect(existsSync(path)).toBe(true);

      started.child.kill('SIGTERM');
      await new Promise((resolve) => started.child.once('exit', resolve));

      // Left behind, it would make the next `lore dev` refuse to start on behalf of a process
      // that no longer exists. On Windows a parent cannot ask for a clean stop at all, which
      // is why the stale-receipt path below is the one that matters there.
      expect(existsSync(path), 'the receipt should be gone after a clean stop').toBe(false);
    },
    120_000,
  );

  it('refuses a second session on the same project, naming the first', async () => {
    const started = await dev();

    const second = spawn(process.execPath, [BINARY, 'dev', project], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    second.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    const code = await new Promise<number>((resolve) => {
      second.once('exit', (value) => resolve(value ?? 0));
    });

    expect(code).not.toBe(0);
    expect(err).toContain('already running');
    expect(err).toContain(String(started.port));
    // The first session is untouched by the refusal.
    expect((await fetch(`http://127.0.0.1:${started.port}/health`)).status).toBe(200);
  }, 120_000);

  it('starts over a receipt whose process is gone', async () => {
    const started = await dev();
    const path = join(project, '.lore', 'dev.json');
    started.child.kill('SIGTERM');
    await new Promise((resolve) => started.child.once('exit', resolve));

    // What a machine that lost power leaves behind: a receipt naming a pid that is not
    // there. It must not be able to stop the next session.
    writeFileSync(
      path,
      JSON.stringify({
        port: started.port,
        pid: 0x7ffffffe,
        startedAt: new Date().toISOString(),
        buildId: `lore_${'a'.repeat(64)}`,
        host: '127.0.0.1',
      }),
      'utf8',
    );

    const second = await dev();
    expect(second.stdout).toContain('MCP stdio');
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(second.child.pid);
  }, 120_000);
});

describe('refusing before it writes anything', () => {
  it('will not create a project inside a project, and leaves the directory alone', async () => {
    const nested = join(project, 'docs', 'inner');
    mkdirSync(nested);

    // The outer project has to exist first, which the first run creates.
    const started = await dev();
    started.child.kill('SIGTERM');
    await new Promise((resolve) => started.child.once('exit', resolve));

    const child = spawn(process.execPath, [BINARY, 'dev', nested], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    const code = await new Promise<number>((resolve) => {
      child.once('exit', (value) => resolve(value ?? 0));
    });

    expect(code).not.toBe(0);
    expect(err).toContain('already inside a Lorepack project');
    // Refused before mutating: nothing was written into the nested directory.
    expect(existsSync(join(nested, 'lore.yaml'))).toBe(false);
  }, 120_000);
});
