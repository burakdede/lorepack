#!/usr/bin/env node
/**
 * The scale envelope, measured: the corpus size architecture section 5.4 says is supported.
 *
 * Separate from `bench.mjs` and `bench-retrieval.mjs` because it answers the question those
 * two cannot. Both use corpora chosen to make their own measurement meaningful: sixty
 * documents for the lifecycle, four hundred for ranking. **Section 5.5's gates are stated
 * against the envelope**, and a number measured on sixty documents is not a number about
 * 2,500 files, however carefully it was taken.
 *
 * It is not part of the default CI benchmark job. Building the envelope takes minutes and
 * gigabytes, which is worth paying deliberately and not on every push.
 *
 *   pnpm bench:envelope
 *   node scripts/bench-envelope.mjs --files 2500 --bytes-per-file 430000 --out benchmarks/envelope.json
 *
 * Results are **reported, not enforced**. The reference machine and the release gates are
 * backlog issue #101 (Phase 7); every number here is labelled provisional and carries the
 * machine that produced it, because a performance number without its machine is not a
 * measurement.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { runBuild } from '../packages/cli/dist/services/build.js';
import { loadConfig, ProgressBus } from '../packages/core/dist/index.js';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};

/** Section 5.4's envelope: 2,500 files, 1 GB total. */
const FILES = argument('files', 2500);
/**
 * Bytes per document, defaulting well below the 1 GB envelope.
 *
 * 430 KB across 2,500 files reaches the 1 GiB byte envelope once headings and body text are
 * included, and writing that many fixtures to a developer
 * machine on a whim is rude. The default is a tenth of that, which measures the **file-count**
 * half of the envelope honestly and says so; pass `--bytes-per-file 430000` for the full one.
 * The report records what was actually written rather than what was intended, so a partial run
 * cannot be mistaken for a full one.
 */
const BYTES_PER_FILE = argument('bytes-per-file', 40_000);
const REBUILD_SAMPLES = argument('rebuild-samples', 5);

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

/**
 * Prose padded to a target size, in sections of a realistic length.
 *
 * The section length is the parameter that matters, and it is not obvious why. **Chunks do not
 * merge across headings**, so a chunk boundary is a heading boundary and the chunk count of a
 * corpus tracks its *heading* count rather than its byte count. A first version of this
 * generator wrote 40 KB as ~230 tiny sections and produced 583,620 chunks from 2,500 files:
 * eleven times the envelope's chunk figure at a tenth of its byte figure, which measures a
 * corpus nobody has.
 *
 * `SECTION_BYTES` is set near the 700-token chunk target, so one section is about one chunk
 * and the corpus lands where section 5.4 says a real project of this size does.
 */
const SECTION_BYTES = 2800;

function document(index, bytes) {
  const head = `# Document ${index}\n\n## Overview\n\nDeployment, rollback, retention and access control for service ${index}.\n\n`;
  const sentence = `Service ${index} records its thresholds, its escalation path and its review cadence here, with the surrounding detail a real page of documentation carries. `;
  const body = sentence.repeat(Math.max(1, Math.round(SECTION_BYTES / sentence.length)));

  const parts = [head];
  let size = head.length;
  let section = 0;
  while (size < bytes) {
    const next = `## Section ${section}\n\n${body}\n\n`;
    parts.push(next);
    size += next.length;
    section += 1;
  }
  return parts.join('');
}

const root = mkdtempSync(join(tmpdir(), 'lorepack-envelope-'));
try {
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: envelope\nsources:\n  - .\n', 'utf8');
  mkdirSync(join(root, 'docs'), { recursive: true });

  let totalBytes = 0;
  for (let index = 0; index < FILES; index += 1) {
    const text = document(index, BYTES_PER_FILE);
    totalBytes += Buffer.byteLength(text);
    writeFileSync(join(root, 'docs', `doc-${String(index).padStart(5, '0')}.md`), text, 'utf8');
  }

  const build = (overrides = {}) =>
    runBuild({
      config: loadConfig({ cwd: root }),
      progress: new ProgressBus(),
      // The envelope is the *supported* size, so measuring it means measuring the path a user
      // on a project this size actually takes, flag and all.
      allowLargeProject: true,
      ...overrides,
    });

  const coldStart = performance.now();
  const cold = await build();
  const coldMs = performance.now() - coldStart;

  /**
   * A rebuild with nothing changed, which is the fingerprint path on its own.
   *
   * Section 5.5's 4-second gate is about deciding what changed, and a no-op rebuild isolates
   * exactly that: every artifact is reused, so what is measured is discovery plus
   * fingerprinting and nothing else.
   */
  const noopSamples = [];
  for (let index = 0; index < REBUILD_SAMPLES; index += 1) {
    const started = performance.now();
    await build();
    noopSamples.push(performance.now() - started);
  }

  /** One document edited, which is the incremental rebuild the gate names. */
  const incrementalSamples = [];
  for (let index = 0; index < REBUILD_SAMPLES; index += 1) {
    writeFileSync(
      join(root, 'docs', 'doc-00000.md'),
      `${document(0, BYTES_PER_FILE)}\n## Edit ${index}\n\nOne section added.\n`,
      'utf8',
    );
    const started = performance.now();
    const rebuilt = await build();
    incrementalSamples.push(performance.now() - started);
    if (rebuilt.reusedArtifacts < FILES - 1) {
      console.warn(
        `bench:envelope: only ${rebuilt.reusedArtifacts} of ${FILES - 1} artifacts were reused; this is not measuring an incremental rebuild.`,
      );
    }
  }

  const report = {
    provisional: true,
    reason:
      'Measured on the development machine. The reference machine and the gates are backlog issue #101.',
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.versions.node,
    },
    corpus: {
      files: FILES,
      bytesPerFile: BYTES_PER_FILE,
      totalBytes,
      totalGb: Math.round((totalBytes / 1024 ** 3) * 1000) / 1000,
      artifacts: cold.counts.artifacts,
      chunks: cold.counts.chunks,
      // Stated plainly, so a run at the default size is never read as a run at the envelope.
      atFileEnvelope: FILES >= 2500,
      atByteEnvelope: totalBytes >= 1024 ** 3,
    },
    measurements: {
      fullBuildMs: Math.round(coldMs),
      noopRebuildP50Ms: percentile(noopSamples, 0.5),
      noopRebuildP95Ms: percentile(noopSamples, 0.95),
      incrementalRebuildP50Ms: percentile(incrementalSamples, 0.5),
      incrementalRebuildP95Ms: percentile(incrementalSamples, 0.95),
      samples: REBUILD_SAMPLES,
    },
    /** Section 5.5, restated so the distance to each numeric gate is visible without looking it up. */
    referenceGates: {
      fingerprintP95Ms: 4000,
      lifecycleIncrementalRebuildMs: 2000,
    },
    envelopeIncrementalRebuildPolicy: 'reported-only',
  };

  const outIndex = process.argv.indexOf('--out');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outIndex !== -1 && process.argv[outIndex + 1] !== undefined) {
    const out = process.argv[outIndex + 1];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, 'utf8');
    console.log(`Wrote ${out}`);
  }
  console.log(serialized);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
