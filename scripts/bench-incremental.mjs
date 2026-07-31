#!/usr/bin/env node
/**
 * Measures the incremental rebuild of one changed ten-page document (architecture 5.5).
 *
 * The gate is "under 2 s after the file is stable". No reference machine exists yet
 * (backlog #101 defines one), so this records a provisional number on whatever machine
 * runs it and prints the specification alongside, rather than pretending to be a gate.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { runBuild } from '../packages/cli/dist/services/build.js';
import { loadConfig, ProgressBus } from '../packages/core/dist/index.js';

const DOCUMENTS = 40;
const PAGES = 10;

function tenPageDocument(seed) {
  const sections = [];
  for (let page = 0; page < PAGES; page += 1) {
    sections.push(`## Section ${page} of ${seed}`);
    for (let paragraph = 0; paragraph < 6; paragraph += 1) {
      sections.push(
        `Paragraph ${paragraph} about subject ${seed} covering behaviour, constraints and ` +
          'examples in enough words to resemble a real page of documentation rather than a stub.',
      );
    }
  }
  return `# Document ${seed}\n\n${sections.join('\n\n')}\n`;
}

const root = mkdtempSync(join(tmpdir(), 'lorepack-bench-'));
try {
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: bench\nsources:\n  - .\n', 'utf8');
  for (let index = 0; index < DOCUMENTS; index += 1) {
    writeFileSync(join(root, `doc-${index}.md`), tenPageDocument(index), 'utf8');
  }

  const build = () => runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });

  const coldStart = performance.now();
  const cold = await build();
  const coldMs = performance.now() - coldStart;

  writeFileSync(join(root, 'doc-0.md'), tenPageDocument('0-edited'), 'utf8');

  const warmStart = performance.now();
  const warm = await build();
  const warmMs = performance.now() - warmStart;

  const report = {
    provisional: true,
    reason: 'Measured on the development machine. The reference machine is backlog #101.',
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.versions.node,
    },
    corpus: { documents: DOCUMENTS, pagesEach: PAGES, chunks: cold.counts.chunks },
    coldBuildMs: Math.round(coldMs),
    incrementalBuildMs: Math.round(warmMs),
    reusedArtifacts: warm.reusedArtifacts,
    rebuiltArtifacts: warm.rebuiltArtifacts,
    gateMs: 2000,
    withinGate: warmMs < 2000,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
