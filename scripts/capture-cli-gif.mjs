#!/usr/bin/env node
// Render the generated terminal demo into a compact animated preview.
// This is a documentation tool only. The CLI package does not depend on ffmpeg or Playwright.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..');
const SVG = join(ROOT, 'docs', 'images', 'demo.svg');
const OUTPUT = join(ROOT, 'docs', 'images', 'demo.gif');

if (!existsSync(SVG)) {
  throw new Error('docs/images/demo.svg is missing; run pnpm docs:capture first');
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  throw new Error(
    'ffmpeg is required for GIF capture; install it locally, then rerun pnpm docs:gif',
  );
}

const frames = mkdtempSync(join(tmpdir(), 'lorepack-demo-'));
const browser = await chromium.launch();
const svg = readFileSync(SVG, 'utf8');

try {
  const page = await browser.newPage({
    viewport: { width: 1240, height: 510 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`
    <!doctype html>
    <style>
      html, body { margin: 0; background: #0b0b0b; }
      body { width: 1240px; padding: 24px; box-sizing: border-box; }
      svg { display: block; width: 1192px; height: auto; }
    </style>
    ${svg}
  `);
  await page.locator('svg').waitFor();
  await page.waitForTimeout(1_500);

  for (let index = 0; index < 280; index += 1) {
    await page.screenshot({ path: join(frames, `frame-${String(index).padStart(3, '0')}.png`) });
    await page.waitForTimeout(100);
  }
} finally {
  await browser.close();
}

mkdirSync(join(ROOT, 'docs', 'images'), { recursive: true });
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '10',
    '-i',
    join(frames, 'frame-%03d.png'),
    '-vf',
    'fps=10,scale=1192:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a',
    '-loop',
    '0',
    OUTPUT,
  ],
  { stdio: 'inherit' },
);

rmSync(frames, { recursive: true, force: true });
console.log(`capture-cli-gif: wrote ${OUTPUT}`);
