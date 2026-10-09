#!/usr/bin/env node
// Capture the documented Studio workflows from a real build and a real browser session.
// The GIFs are derived artifacts. Regenerate them with `pnpm docs:studio:gifs` after UI changes.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..');
const BINARY = join(ROOT, 'packages', 'cli', 'dist', 'entry.js');
const OUTPUT = join(ROOT, 'docs', 'images');
const PORT = 43_192;

const RUNBOOK = [
  '# Release runbook',
  '',
  '## Deploy checklist',
  '',
  'Run the smoke tests, then promote the build.',
  '',
  '## Rolling back',
  '',
  'Run `lorepack rollback` to point at the previous build. Nothing is recompiled.',
  '',
].join('\n');

function run(project, args) {
  const result = execFileSync(process.execPath, [BINARY, '--cwd', project, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result;
}

function createProject() {
  const project = mkdtempSync(join(tmpdir(), 'lorepack-studio-gifs-'));
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'runbook.md'), RUNBOOK, 'utf8');
  writeFileSync(
    join(project, 'docs', 'onboarding.md'),
    '# Onboarding\n\nAsk in the engineering channel for repository access.\n',
    'utf8',
  );
  writeFileSync(
    join(project, 'docs', 'pricing.csv'),
    'sku,list_price\nA-1,19.99\nA-2,4.50\n',
    'utf8',
  );
  writeFileSync(join(project, 'docs', 'diagram.bin'), Buffer.from([0, 1, 2, 3]));
  mkdirSync(join(project, 'drafts'), { recursive: true });
  writeFileSync(join(project, 'drafts', 'unfinished.md'), '# Unfinished\n', 'utf8');

  run(project, ['init', '.']);
  writeFileSync(join(project, '.loreignore'), 'drafts/\n', { flag: 'a' });
  run(project, ['build']);
  writeFileSync(
    join(project, 'docs', 'runbook.md'),
    `${RUNBOOK}\n## Change freeze\n\nNo deployments during a change freeze.\n`,
    'utf8',
  );
  run(project, ['build']);
  return project;
}

async function waitForServer(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`lorepack dev exited ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`lorepack dev never answered on ${PORT}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function writeGif(page, name, workflow) {
  const frames = mkdtempSync(join(tmpdir(), `lorepack-${name}-`));
  let frame = 0;
  const hold = async () => {
    for (let index = 0; index < 10; index += 1) {
      await page.screenshot({ path: join(frames, `frame-${String(frame).padStart(3, '0')}.png`) });
      frame += 1;
      await page.waitForTimeout(100);
    }
  };

  try {
    await workflow(hold);
    mkdirSync(OUTPUT, { recursive: true });
    // biome-ignore format: keep the generated argument list compact for readable diffs
    const ffmpegArgs = ['-y', '-loglevel', 'error', '-framerate', '10', '-i', join(frames, 'frame-%03d.png'), '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a', '-loop', '0', join(OUTPUT, `${name}.gif`)];
    execFileSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
    console.log(`capture-studio-gifs: wrote ${name}.gif`);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

async function main() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg is required for Studio GIF capture; install it and rerun the command');
  }

  const project = createProject();
  const child = spawn(process.execPath, [BINARY, 'dev', project, '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const url = `http://127.0.0.1:${PORT}`;
    await page.evaluate(() => document.fonts.ready);

    await writeGif(page, 'studio-first-build', async (hold) => {
      await page.goto(`${url}/#/`);
      await page.locator('.header-id').waitFor();
      await hold();
      await page.goto(`${url}/#/sources`);
      await page.getByRole('button', { name: 'docs/runbook.md' }).click();
      await page.getByRole('complementary', { name: /docs\/runbook\.md/ }).waitFor();
      await hold();
      await page.getByRole('button', { name: /excluded \d/ }).click();
      await page.getByText('docs/diagram.bin').waitFor();
      await hold();
    });

    await writeGif(page, 'studio-playground', async (hold) => {
      await page.goto(`${url}/#/playground`);
      await page.getByLabel('Task').fill('how do I roll back a release');
      await page.getByRole('button', { name: 'Assemble' }).click();
      await page.locator('.item').first().waitFor();
      await hold();
      await page.getByRole('region', { name: 'Use it anywhere' }).scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.item .citation-link').first().click();
      await page.locator('.reader-line-marked').first().waitFor();
      await hold();
    });

    await writeGif(page, 'studio-versions', async (hold) => {
      await page.goto(`${url}/#/versions`);
      await page.locator('.diff-section').first().waitFor();
      await hold();
      const activate = page.getByRole('button', { name: /^Activate lore_/ }).first();
      const target = ((await activate.getAttribute('aria-label')) ?? '').replace('Activate ', '');
      await activate.click();
      const confirmation = page.getByRole('region', { name: `Activate ${target}` });
      await confirmation.getByRole('button', { name: `Activate ${target}` }).click();
      await page.locator('.outcome').waitFor();
      await hold();
      await page.getByRole('button', { name: 'Roll back' }).click();
      const rollback = page.getByRole('region', { name: /^Roll back to lore_/ });
      await rollback.getByRole('button', { name: /^Roll back to lore_/ }).click();
      await page.locator('.outcome').waitFor();
      await hold();
    });

    await browser.close();
  } finally {
    await stop(child);
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await main();
