import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  makeDocx,
  makePdf,
  makeXlsx,
  number,
  paragraph,
  row,
  shared,
  table,
} from '@lorepack/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EGRESS_FIXTURES,
  egressProblems,
  IN_NETWORK_NAMESPACE,
  runSandboxedBuild,
} from './sandbox/sandbox.js';

/**
 * One file for every built-in parser, each carrying something a careless parser might fetch:
 * an external URL, a script, a remote image. The first version of this test built Markdown,
 * HTML and CSV only, so the PDF, DOCX and XLSX readers were never inside the proof (#616).
 */
async function writeCorpus(root: string): Promise<void> {
  const write = (path: string, contents: string | Uint8Array): void => {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };
  write('lore.yaml', 'version: 1\nname: offline\nsources:\n  - .\n');
  write(
    'docs/runbook.md',
    '# Runbook\n\nA remote URL such as https://example.invalid/data must stay inert.\n\n![remote](https://example.invalid/pixel.png)\n',
  );
  write(
    'docs/page.html',
    '<!doctype html><title>Offline</title><link rel="stylesheet" href="https://example.invalid/a.css"><script>fetch("https://example.invalid")</script><img src="https://example.invalid/i.png"><p>Local only.</p>',
  );
  write('docs/notes.txt', 'Plain text naming https://example.invalid/notes.\n');
  write('data/owners.csv', 'team,owner\nruntime,ops@example.test\n');
  write(
    'docs/report.pdf',
    makePdf([{ lines: ['Quarterly report', 'See https://example.invalid/report'] }], {
      title: 'Report',
    }),
  );
  write(
    'docs/policy.docx',
    await makeDocx({
      body: [
        paragraph('Policy', 'Heading1'),
        paragraph('Linked from https://example.invalid/policy.'),
        table([
          ['owner', 'team'],
          ['ops', 'runtime'],
        ]),
      ].join(''),
    }),
  );
  write(
    'data/orders.xlsx',
    await makeXlsx({
      sharedStrings: ['sku', 'qty', 'A-1'],
      sheets: [
        {
          name: 'Orders',
          rows: [
            row(1, [shared('A1', 0), shared('B1', 1)]),
            row(2, [shared('A2', 2), number('B2', 5)]),
          ].join(''),
        },
      ],
    }),
  );
}

const FORMATS = 7;

let root = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lore-privacy-'));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A fresh project per run, so one build's `.lore` never feeds the next. */
async function project(name: string): Promise<string> {
  const path = join(root, name);
  await writeCorpus(path);
  return path;
}

const egress = (name: string): string => join(EGRESS_FIXTURES, name);

describe('privacy defaults: no telemetry or source egress in the build path, issue 616', () => {
  it('builds every parser format in a sandbox with no network, process or thread, and attempts nothing', async () => {
    const run = runSandboxedBuild(await project('clean'));

    expect(egressProblems(run)).toEqual([]);
    expect(run.attempts).toEqual([]);
    expect(run.stdout).toMatch(/Build lore_[0-9a-f]{64}/);
    expect(run.stdout).toContain(`${FORMATS} artifacts`);
  });

  /**
   * The four routes #616 showed the first version missed, each loaded into the real build
   * process. Every one passed a test that only stubbed `fetch` and `net.Socket.connect`.
   */
  it.each([
    ['a DNS query', 'dns.mjs', /network attempt: dns\.lookup/],
    ['a UDP datagram', 'dgram.mjs', /network attempt: udp\.socket/],
    [
      'a child process that connects',
      'child-process.mjs',
      /network attempt: child_process\.spawnSync[\s\S]*ERR_ACCESS_DENIED|ERR_ACCESS_DENIED[\s\S]*network attempt: child_process\.spawnSync/,
    ],
    [
      'a fetch from a worker thread',
      'worker-fetch.mjs',
      /ERR_ACCESS_DENIED[\s\S]*network attempt: worker_threads\.Worker/,
    ],
  ])('fails when the build path sends %s', async (_name, file, expected) => {
    const run = runSandboxedBuild(await project(file), { inject: [egress(file)] });

    expect(egressProblems(run).join('\n')).toMatch(expected);
  });

  it.each([
    ['fetch', 'fetch.mjs', /network attempt: undici:request:create/],
    ['a TLS connection', 'tls.mjs', /network attempt: net\.client\.socket/],
  ])('still fails on %s, which the first version did catch', async (_name, file, expected) => {
    const run = runSandboxedBuild(await project(file), { inject: [egress(file)] });

    expect(egressProblems(run).join('\n')).toMatch(expected);
  });
});

/**
 * The kernel's view, which no JavaScript can talk its way around.
 *
 * Only on Linux, and only in the CI job that runs this file inside a fresh network and mount
 * namespace (`tools/security/test/sandbox/netns.sh`): macOS and Windows have no unprivileged
 * equivalent, and creating one on Linux needs root, which `pnpm test:security` should never
 * ask a contributor for. The permission sandbox above runs everywhere.
 */
describe.runIf(IN_NETWORK_NAMESPACE)('inside a network namespace, issue 616', () => {
  it('has no route out, and counts every packet on an interface that drops it', () => {
    expect(
      new Set(
        readFileSync('/proc/net/dev', 'utf8')
          .match(/^\s*(\w+):/gm)
          ?.map((m) => m.trim().slice(0, -1)),
      ),
    ).toEqual(new Set(['lo', 'dummy0']));
    expect(readFileSync('/etc/resolv.conf', 'utf8')).toMatch(/^nameserver 10\.203\.0\.2$/m);
  });

  it('builds every format offline and transmits no packet at all', async () => {
    const run = runSandboxedBuild(await project('netns-clean'));

    expect(egressProblems(run)).toEqual([]);
    expect(run.packets).toBe(0);
    expect(run.stdout).toContain(`${FORMATS} artifacts`);
  });

  it.each([
    ['a DNS query', 'dns.mjs'],
    ['a UDP datagram', 'dgram.mjs'],
    ['fetch', 'fetch.mjs'],
  ])('counts %s with the in-process monitor switched off', async (_name, file) => {
    const run = runSandboxedBuild(await project(`netns-${file}`), {
      monitor: false,
      inject: [egress(file)],
    });

    expect(run.attempts).toEqual([]);
    expect(run.packets).toBeGreaterThan(0);
    expect(egressProblems(run).join('\n')).toMatch(/packets left the build's network namespace/);
  });
});
