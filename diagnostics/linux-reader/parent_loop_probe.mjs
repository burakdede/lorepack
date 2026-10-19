import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const requested = process.env.LORE_LOOP_RECEIPT;
if (!requested || !isAbsolute(requested))
  throw new Error('Expected absolute diagnostic receipt path.');
const output = join(
  realpathSync(dirname(requested)),
  requested.slice(requested.lastIndexOf('/') + 1),
);
const candidate = realpathSync(process.cwd());
if (output.startsWith(`${candidate}/`) || output === candidate || existsSync(output)) {
  throw new Error('Diagnostic receipt must be fresh and outside the candidate.');
}
const started = performance.now();
const initialElu = performance.eventLoopUtilization();
let previousElu = initialElu;
let lastTick = started;
let totalSamples = 0;
let globalMaxDelayMs = null;
let errorObservation = null;
const samples = [];
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const finite = (value) => (Number.isFinite(value) ? value : null);
function snapshot(phase) {
  const now = performance.now();
  const currentElu = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(currentElu, previousElu);
  const count = histogram.count;
  const maxMs = count ? histogram.max / 1e6 : null;
  if (maxMs !== null) globalMaxDelayMs = Math.max(globalMaxDelayMs ?? 0, maxMs);
  const sample = {
    index: totalSamples++,
    phase,
    elapsedMs: now - started,
    tickGapMs: now - lastTick,
    histogramCount: count,
    delayMaxMs: maxMs,
    delayMeanMs: count ? finite(histogram.mean / 1e6) : null,
    delayP95Ms: count ? finite(histogram.percentile(95) / 1e6) : null,
    elu: {
      activeMs: finite(delta.active),
      idleMs: finite(delta.idle),
      utilization: finite(delta.utilization),
    },
  };
  if (samples.length === 200) samples.shift();
  samples.push(sample);
  histogram.reset();
  previousElu = currentElu;
  lastTick = now;
}
const sampler = setInterval(() => snapshot('interval'), 100);
sampler.unref();
process.once('uncaughtExceptionMonitor', (error, origin) => {
  try {
    snapshot('uncaught');
    const causes = [];
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      causes.push({
        name: typeof current.name === 'string' ? current.name.slice(0, 128) : null,
        code: typeof current.code === 'string' ? current.code.slice(0, 64) : null,
      });
      current = current.cause;
    }
    errorObservation = { elapsedMs: performance.now() - started, origin, causes };
  } catch {
    errorObservation = {
      elapsedMs: performance.now() - started,
      origin: 'observation-unavailable',
    };
  }
});
process.once('exit', (exitCode) => {
  try {
    clearInterval(sampler);
    histogram.disable();
    snapshot('exit');
    const elu = performance.eventLoopUtilization(initialElu);
    const receipt = {
      schema: 1,
      purpose: 'Parent-loop diagnostic only; not native I/O service timing or release evidence.',
      utc: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      startedMs: started,
      elapsedMs: performance.now() - started,
      pid: process.pid,
      ppid: process.ppid,
      exitCode,
      argv: process.argv.slice(0, 8).map((value) => value.slice(0, 512)),
      execArgv: process.execArgv.slice(0, 8).map((value) => value.slice(0, 512)),
      candidate: candidate.slice(0, 512),
      binding: {
        head: process.env.LORE_LOOP_HEAD?.slice(0, 40) ?? null,
        readerSha256: process.env.LORE_LOOP_READER_SHA?.slice(0, 64) ?? null,
        preloadSha256: createHash('sha256')
          .update(readFileSync(fileURLToPath(import.meta.url)))
          .digest('hex'),
      },
      environment: {
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE?.slice(0, 32) ?? null,
        NODE_OPTIONS: process.env.NODE_OPTIONS?.slice(0, 512) ?? null,
      },
      controls: { resolutionMs: 10, aggregationMs: 100, ringLimit: 200, receiptLimitBytes: 131072 },
      totalSamples,
      droppedSamples: totalSamples - samples.length,
      samples,
      globalMaxDelayMs,
      elu: {
        activeMs: finite(elu.active),
        idleMs: finite(elu.idle),
        utilization: finite(elu.utilization),
      },
      errorObservation,
    };
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    if (Buffer.byteLength(bytes) <= 131072) writeFileSync(output, bytes, { flag: 'wx' });
  } catch {
    // Diagnostic custody is checked externally; observation cannot replace the workload exit.
  }
});
