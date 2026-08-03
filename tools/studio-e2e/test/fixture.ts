import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import type { AxeResults } from 'axe-core';

/**
 * A real project, a real `lore dev`, and the browser pointed at it.
 *
 * No mocking anywhere in this suite. The whole reason it exists is that the component tests
 * mock `fetch`, so they cannot catch a route that asks for a field the server does not send,
 * an asset path that 404s once bundled, or a page that scrolls sideways at the documented
 * viewport. Those are the defects this suite is for.
 *
 * Two builds are made before the server starts, because half of Versions needs a history to
 * act on and a diff needs two things to compare.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY = join(HERE, '..', '..', '..', 'packages', 'cli', 'dist', 'entry.js');

const RUNBOOK = [
  '---',
  'authority: 80',
  '---',
  '',
  '# Release runbook',
  '',
  '## Deploy checklist',
  '',
  'Run the smoke tests, then promote the build.',
  '',
  '## Rolling back',
  '',
  'Run `lore rollback` to point at the previous build. Nothing is recompiled.',
  '',
].join('\n');

const ONBOARDING = [
  '# Onboarding',
  '',
  '## Access',
  '',
  'Ask in the engineering channel for repository access.',
  '',
].join('\n');

const require = createRequire(import.meta.url);

export interface Session {
  readonly url: string;
  readonly projectRoot: string;
}

/** Test-scoped: a new one per test, because it acts on that test's page. */
interface TestFixtures {
  /** Runs axe against the current page and fails on any critical or serious violation. */
  readonly checkA11y: () => Promise<AxeResults>;
}

/** Worker-scoped: one project and one server for the whole run. */
interface WorkerFixtures {
  readonly session: Session;
}

function lore(project: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, '--cwd', project, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`lore ${args.join(' ')} exited ${code}:\n${output}`));
    });
  });
}

/** One project and one server for the whole run, because building per test is minutes. */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  session: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture signature.
    async ({}, use) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'lore-studio-e2e-'));
      mkdirSync(join(projectRoot, 'docs'));
      writeFileSync(join(projectRoot, 'docs', 'runbook.md'), RUNBOOK, 'utf8');
      writeFileSync(join(projectRoot, 'docs', 'onboarding.md'), ONBOARDING, 'utf8');
      // A file no parser handles, so the exclusion list on Sources has something real in it.
      writeFileSync(join(projectRoot, 'docs', 'diagram.bin'), Buffer.from([0, 1, 2, 3]));

      await lore(projectRoot, ['init', '.']);
      await lore(projectRoot, ['build']);
      // A second build, so Versions has a history to compare, activate and roll back.
      writeFileSync(
        join(projectRoot, 'docs', 'runbook.md'),
        `${RUNBOOK}\n## Change freeze\n\nNo deployments during a change freeze.\n`,
        'utf8',
      );
      await lore(projectRoot, ['build']);

      const port = 43_190;
      const child = spawn(process.execPath, [BINARY, 'dev', projectRoot, '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const url = await waitForServer(child, port);

      await use({ url, projectRoot });

      await stop(child);
      rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    { scope: 'worker' },
  ],

  checkA11y: async ({ page }, use) => {
    await use(async () => {
      // Injected from the installed package rather than a CDN: this suite runs offline,
      // like everything else in this product.
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const results = (await page.evaluate(async () => {
        // @ts-expect-error injected above
        return (await window.axe.run(document, {
          resultTypes: ['violations'],
        })) as AxeResults;
      })) as AxeResults;

      const serious = results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      );
      if (serious.length > 0) {
        const described = serious
          .map(
            (violation) =>
              `${violation.impact} ${violation.id}: ${violation.help}\n    ${violation.nodes
                .map((node) => node.target.join(' '))
                .join('\n    ')}`,
          )
          .join('\n  ');
        throw new Error(`axe found critical or serious violations:\n  ${described}`);
      }
      return results;
    });
  },
});

export { expect } from '@playwright/test';

async function waitForServer(child: ChildProcess, port: number): Promise<string> {
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`lore dev exited ${child.exitCode}:\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return `http://127.0.0.1:${port}`;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`lore dev never answered on ${port}:\n${output}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const give = setTimeout(resolve, 10_000);
    child.once('exit', () => {
      clearTimeout(give);
      resolve(undefined);
    });
  });
}
