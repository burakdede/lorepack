#!/usr/bin/env node
// The pictures in the documentation, regenerated from a real build rather than pasted in once.
//
// Every image under `docs/images/` comes out of this script: a demo project is built, a real
// `lore dev` serves it, the CLI transcripts are captured by running the actual commands, and
// Studio is photographed in the browser the end-to-end suite already uses.
//
// The reason it is a script and not a folder of hand-taken screenshots is section 8 of
// AGENTS.md: documentation is part of the change. A screenshot nobody can regenerate becomes
// wrong on the first UI edit and stays wrong, and by then it is easier to delete than to
// retake. `pnpm docs:capture` makes retaking it the cheap option.
//
// Terminal output is rendered to SVG rather than recorded as a GIF. A GIF needs a recorder and
// an encoder, which is a toolchain this project does not have and invariant 7 does not want;
// an SVG of real captured bytes is dependency-free, scales, stays legible on a high-density
// screen, and diffs as text so a review can see what the output became.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BINARY = join(ROOT, 'packages', 'cli', 'dist', 'entry.js');
const IMAGES = join(ROOT, 'docs', 'images');
const PORT = 43_991;

/**
 * The demo project.
 *
 * Deliberately ordinary: the documents a small team would actually keep, long enough that
 * retrieval has something to choose between and short enough that a screenshot is readable.
 * One file no parser handles and one directory an ignore rule removes, because "what is not
 * in the build" is half of what Studio is for and an empty exclusion list would show none of
 * it.
 */
const PROJECT = {
  'context/engineering/retention.md': `# Data retention

## Retention windows

Customer account records are kept for seven years after the account closes. Billing invoices
are kept for ten years, because the tax authority requires it. Support transcripts are kept
for eighteen months.

Deletion requests under GDPR article 17 are honoured within thirty days. The deletion pipeline
runs nightly and writes an audit row for every record it removes.

## Backups

Nightly snapshots live in object storage for thirty-five days. A restore drill runs on the
first Tuesday of each quarter.

## Exceptions

An account under legal hold is exempt from every window above until the hold is released.
`,
  'context/engineering/auth.md': `# Authentication

## Sessions

Sessions are stateless. The gateway issues a signed token with a fifteen minute lifetime and a
refresh token with a fourteen day lifetime, rotated on every use.

## Passwords

Passwords are hashed with Argon2id, memory cost 64 MiB, time cost 3, parallelism 1. Every hash
records the parameters it was produced with, so an older hash can be upgraded on next login.

## Rate limits

Login is limited to ten attempts per account per hour. Exceeding it returns 429 with a
Retry-After header. The limiter fails closed: if the store is unreachable, login is refused
rather than allowed.
`,
  'context/ops/incidents.md': `# Incident response

## Severities

A severity one incident is a total outage or a confirmed data loss. A severity two is degraded
service affecting more than ten percent of requests.

## Roles

Every incident has a commander, and the commander does not fix anything. The commander runs
the timeline, decides on communication, and declares the end.

## After the incident

A written review is due within five working days. It names causes, not people.
`,
  'context/product/onboarding.md': `# Onboarding

## Goal

A new team reaches their first successful import within ten minutes, without talking to
anyone.

## Steps

1. Sign up.
2. Name the workspace.
3. Choose a template, or skip.
4. Invite teammates, or skip.
5. Import data, which is the step everything else exists to reach.

## Measured drop-off

The largest drop-off is at the import step, not at signup.
`,
  'context/notes/sprint.txt':
    'Sprint notes.\n\nThe auth rewrite landed behind a flag. The retention pipeline still runs nightly.\n',
  /**
   * A spreadsheet, because half of what Phase 5 added is that a mixed folder is a mixed
   * folder. A demo of nothing but prose would photograph a product that does not exist.
   *
   * Ordinary in the same way the documents are: the sort of small operational table a team
   * keeps beside its runbooks, with a missing value and a boolean in it so the typed columns
   * are visibly typed rather than all text.
   */
  'context/ops/environments.csv': [
    'environment,region,tier,paged,monthly_cost_usd',
    'production,eu-west-1,critical,true,4210.50',
    'staging,eu-west-1,standard,false,318.75',
    'sandbox,us-east-1,standard,false,',
    '',
  ].join('\n'),
  'drafts/unfinished.md': '# Unfinished\n\nNot ready to be read by anything.\n',
};

/**
 * Runs a command and returns what a reader would see.
 *
 * `progress` decides whether the stage table is part of the picture. It is written to stderr,
 * which is the whole point of the output contract: with `--json` stdout carries the result and
 * nothing else. For `lore build` the stages *are* the interesting part; for `lore status` they
 * are two seconds of scaffolding in front of one sentence, so they are left out.
 */
function lore(cwd, args, { progress = false } = {}) {
  const result = spawnSync(process.execPath, [BINARY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', COLUMNS: '92' },
  });
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  }
  return progress ? `${result.stderr}${result.stdout}` : result.stdout;
}

/**
 * Real output, rendered as a terminal.
 *
 * Colour is forced off when capturing and reapplied here from the shape of the line, so the
 * SVG never has to parse ANSI. That is a deliberate trade: the picture is a rendering of the
 * text rather than a photograph of a terminal, and the text is the part that has to be true.
 */
function terminalSvg(title, blocks) {
  const CHAR = 8.4;
  const LINE = 21;
  const PAD = 20;
  const lines = [];

  for (const block of blocks) {
    lines.push({ text: `$ ${block.command}`, kind: 'command' });
    for (const line of block.output.replace(/\s+$/, '').split('\n')) {
      lines.push({ text: line, kind: 'output' });
    }
    lines.push({ text: '', kind: 'output' });
  }
  while (lines.length > 0 && lines.at(-1).text === '') lines.pop();

  const columns = Math.max(48, ...lines.map((line) => line.text.length)) + 2;
  const width = Math.round(columns * CHAR + PAD * 2);
  const height = lines.length * LINE + PAD * 2 + 34;

  const escaped = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const body = lines
    .map((line, index) => {
      const y = PAD + 34 + index * LINE;
      const fill =
        line.kind === 'command'
          ? '#e6e6e6'
          : /^\s*(Build|Studio|HTTP|MCP|Project|Active build)\b/.test(line.text)
            ? '#c9c9c9'
            : '#9a9a9a';
      const weight = line.kind === 'command' ? '500' : '400';
      return `<text x="${PAD}" y="${y}" fill="${fill}" font-weight="${weight}" xml:space="preserve">${escaped(line.text)}</text>`;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escaped(title)}">
  <rect width="${width}" height="${height}" rx="6" fill="#141414"/>
  <circle cx="${PAD}" cy="20" r="5" fill="#3a3a3a"/>
  <circle cx="${PAD + 16}" cy="20" r="5" fill="#3a3a3a"/>
  <circle cx="${PAD + 32}" cy="20" r="5" fill="#3a3a3a"/>
  <text x="${PAD + 52}" y="24" fill="#6a6a6a" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${escaped(title)}</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
  ${body}
  </g>
</svg>
`;
}

async function waitForServer(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`lore dev exited ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`lore dev never answered on ${PORT}`);
}

async function main() {
  if (!existsSync(BINARY)) {
    console.error('capture-docs: build first (`pnpm build`).');
    process.exit(1);
  }
  mkdirSync(IMAGES, { recursive: true });

  const project = mkdtempSync(join(tmpdir(), 'lore-docs-'));
  for (const [path, contents] of Object.entries(PROJECT)) {
    const full = join(project, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }

  let child;
  try {
    // The two-command flow, captured by running it.
    const init = lore(project, ['init', '.']);
    // The project is named after its directory, and its directory here is a temp path with a
    // random suffix. Renaming it keeps the pictures about Lorepack rather than about mkdtemp.
    writeFileSync(
      join(project, 'lore.yaml'),
      'version: 1\nname: team-context\n\nsources:\n  - .\n',
    );
    writeFileSync(join(project, '.loreignore'), 'drafts/\n', { flag: 'a' });
    // A file no parser handles, added after init so it is not in the seeded ignore list.
    writeFileSync(join(project, 'context', 'notes', 'diagram.bin'), Buffer.from([0, 1, 2, 3]));

    const build = lore(project, ['build'], { progress: true });
    writeFileSync(
      join(IMAGES, 'cli-build.svg'),
      terminalSvg('lore init and lore build', [
        { command: 'lore init .', output: init },
        { command: 'lore build', output: build },
      ]),
      'utf8',
    );

    writeFileSync(
      join(IMAGES, 'cli-inspect.svg'),
      terminalSvg('inspecting what is in the build, and what is not', [
        { command: 'lore status', output: lore(project, ['status']) },
        { command: 'lore inspect exclusions', output: lore(project, ['inspect', 'exclusions']) },
      ]),
      'utf8',
    );

    writeFileSync(
      join(IMAGES, 'cli-search.svg'),
      terminalSvg('every result carries where it came from', [
        {
          command: 'lore search "how long do we keep support transcripts"',
          output: lore(project, ['search', 'how long do we keep support transcripts']),
        },
      ]),
      'utf8',
    );

    // A second build, so Versions has a history to show.
    writeFileSync(
      join(project, 'context', 'engineering', 'auth.md'),
      `${PROJECT['context/engineering/auth.md']}\n## WebAuthn\n\nBehind a flag for internal accounts only.\n`,
      'utf8',
    );
    lore(project, ['build']);

    child = spawn(process.execPath, [BINARY, 'dev', project, '--port', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(child);

    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    // A laptop, not the narrowest supported window. 1280 is the width the accessibility suite
    // asserts against, because that is the floor; Versions puts Compare, Activate and Pack on
    // every row and at the floor the last of them is inside the table's own scroll box, which
    // is correct behaviour and a poor photograph of it.
    const page = await browser.newPage({
      viewport: { width: 1512, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    });

    const url = `http://127.0.0.1:${PORT}`;

    /**
     * The viewport, not the whole page.
     *
     * A full-page capture of the Playground is four thousand pixels tall, and a four thousand
     * pixel image in a README renders as an unreadable strip. Every picture here is what fits
     * on the documented laptop screen, which is also the thing the accessibility suite checks,
     * so the documentation and the tests are describing the same window.
     */
    const shoot = async (file) => {
      await page.screenshot({ path: join(IMAGES, file) });
      console.log(`capture-docs: ${file}`);
    };

    const shots = [
      { file: 'studio-overview.png', route: '#/', ready: '.state-banner' },
      { file: 'studio-sources.png', route: '#/sources', ready: '.artifacts' },
      { file: 'studio-versions.png', route: '#/versions', ready: '.build-row' },
      { file: 'studio-tables.png', route: '#/tables', ready: '.tables-schema' },
      { file: 'studio-diagnostics.png', route: '#/diagnostics', ready: '.checks' },
    ];

    for (const shot of shots) {
      await page.goto(`${url}/${shot.route}`);
      await page.locator(shot.ready).first().waitFor();
      await shoot(shot.file);
    }

    // The Playground needs a task run before there is anything to photograph, and the part
    // worth photographing is the accounting with the passages under it.
    await page.goto(`${url}/#/playground`);
    await page.getByLabel('Task').fill('what is our data retention window for support transcripts');
    await page.getByRole('button', { name: 'Assemble' }).click();
    await page.locator('.item').first().waitFor();
    await shoot('studio-playground.png');

    // The omissions table is deliberately not photographed. It only exists when something was
    // omitted, so capturing it would mean sizing the demo corpus to force an omission, and a
    // demo shaped around its own screenshot stops being a demo.

    // The exclusions view, which is the half of Sources that gets buried.
    await page.goto(`${url}/#/sources`);
    await page.getByRole('button', { name: /excluded \d+/ }).click();
    await page.locator('.artifacts').first().waitFor();
    await shoot('studio-excluded.png');

    await browser.close();
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const give = setTimeout(resolve, 10_000);
        child.once('exit', () => {
          clearTimeout(give);
          resolve(undefined);
        });
      });
    }
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log(`capture-docs: wrote images to ${IMAGES}`);
}

await main();
