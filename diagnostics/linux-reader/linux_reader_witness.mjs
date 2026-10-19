import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (index % 2 === 0) {
      if (!value.startsWith('--') || args[index + 1] === undefined)
        throw new Error('Expected flag/value pairs.');
      pairs.push([value.slice(2), args[index + 1]]);
    }
    return pairs;
  }, []),
);
const required = [
  'candidate',
  'expected-head',
  'expected-reader-dist-sha256',
  'condition',
  'output',
];
if (Object.keys(options).length !== required.length || required.some((key) => !options[key]))
  throw new Error(`Required flags: ${required.join(', ')}`);
if (process.platform !== 'linux' || process.version !== 'v24.21.0')
  throw new Error('Requires Linux and Node v24.21.0.');
if (!['idle', 'parent-stall'].includes(options.condition)) throw new Error('Unknown condition.');
if (
  !/^[a-f0-9]{40}$/.test(options['expected-head']) ||
  !/^[a-f0-9]{64}$/.test(options['expected-reader-dist-sha256'])
)
  throw new Error('Invalid binding.');
const candidate = realpathSync(options.candidate);
const requestedOutput = resolve(options.output);
const output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
if (output === candidate || output.startsWith(`${candidate}/`) || existsSync(output))
  throw new Error('Output must be fresh and outside the candidate.');
const git = (...args) =>
  execFileSync('git', ['-C', candidate, ...args], { encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path) => hash(readFileSync(path));
const sourcePath = 'packages/parsers/src/resident_memory.ts';
const builtPath = 'packages/parsers/dist/resident_memory.js';
const sourcePaths = [
  sourcePath,
  'packages/parsers/src/isolation.ts',
  'packages/parsers/test/resident_memory.test.ts',
  'packages/parsers/test/linux_resident_memory.test.ts',
  'scripts/bench-corpus.mjs',
  'scripts/research-safe-pruning.mjs',
  '.github/workflows/benchmarks.yml',
  'packages/cli/src/services/build.ts',
];
const sources = sourcePaths.map((path) => ({ path, sha256: fileHash(join(candidate, path)) }));
const coreResolvedPath = realpathSync(
  createRequire(join(candidate, builtPath)).resolve('@lorepack/core'),
);
const binding = {
  head: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  status: git('status', '--porcelain'),
  sourceSha256: fileHash(join(candidate, sourcePath)),
  readerDistSha256: fileHash(join(candidate, builtPath)),
  witnessSha256: fileHash(fileURLToPath(import.meta.url)),
  nodeExecutable: { path: realpathSync(process.execPath), sha256: fileHash(process.execPath) },
  coreEntry: { path: coreResolvedPath, sha256: fileHash(coreResolvedPath) },
  sources,
};
if (binding.head !== options['expected-head'] || binding.status !== '')
  throw new Error('Candidate is not the expected clean HEAD.');
if (
  binding.sourceSha256 !== 'f1cd41ccde9a0b6b8f474431df06c7e0b2a41961bcae65e8bbcf11f2c7fc3327' ||
  binding.readerDistSha256 !== options['expected-reader-dist-sha256']
)
  throw new Error('Reader binding differs.');
mkdirSync(output, { recursive: false });
const started = performance.now();
const events = [];
const record = (event, details = {}) =>
  events.push({ event, parentMs: performance.now() - started, ...details });
const serializeError = (error, depth = 0) => {
  if (error === undefined) return null;
  if (error === null || typeof error !== 'object') return { value: String(error) };
  return {
    name: error.name ?? null,
    code: error.code ?? null,
    message: error.message ?? null,
    stack: error.stack ?? null,
    cause: depth < 5 ? serializeError(error.cause, depth + 1) : 'depth-limit',
  };
};
const liveness = (pid) => {
  if (!Number.isSafeInteger(pid)) return { state: 'unverified', reason: 'no-pid' };
  try {
    process.kill(pid, 0);
    return { state: 'present' };
  } catch (error) {
    return {
      state: error.code === 'ESRCH' ? 'absent' : 'unverified',
      error: serializeError(error),
    };
  }
};
let child;
let closed;
let closeResult;
let spawnError;
let failure;
let observations;
let signalReceived;
const terminate = (signal) => {
  signalReceived = signal;
  record('controller-signal', { signal });
  child?.kill('SIGKILL');
};
process.once('SIGTERM', terminate);
process.once('SIGINT', terminate);
const watchdog = setTimeout(() => {
  failure ??= new Error('Witness 15-second custody bound exceeded.');
  terminate('watchdog');
}, 15000);
try {
  const { readLinuxResidentMemory } = await import(pathToFileURL(join(candidate, builtPath)).href);
  if (typeof readLinuxResidentMemory !== 'function')
    throw new Error('Public actual built reader export missing.');
  child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 10000); setInterval(() => {}, 1000);",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  closed = new Promise((yes) =>
    child.once('close', (code, signal) => {
      closeResult = { code, signal, stdout, stderr };
      record('child-close', closeResult);
      rejectReady(new Error('Idle child closed before readiness.'));
      yes(closeResult);
    }),
  );
  child.once('error', (error) => {
    spawnError = error;
    rejectReady(error);
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 256) {
      rejectReady(new Error('Unexpected child output.'));
      child.kill('SIGKILL');
    } else if (stdout === 'ready\n') resolveReady();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 1024) child.kill('SIGKILL');
  });
  record('child-spawn', { pid: child.pid ?? null });
  await ready;
  const observe = async (phase, stallMs) => {
    const before = liveness(child.pid);
    if (before.state !== 'present') throw new Error('Idle child not verified alive before read.');
    const begin = performance.now();
    record('read-begin', { phase, pid: child.pid, liveness: before });
    const probeBegin = performance.now();
    const lagProbe = new Promise((yes) =>
      setTimeout(() => {
        const lagMs = performance.now() - probeBegin;
        record('zero-timer-fired', { phase, lagMs });
        yes(lagMs);
      }, 0),
    );
    const pending = readLinuxResidentMemory(child.pid).then(
      (bytes) => ({ outcome: 'fulfilled', bytes }),
      (error) => ({ outcome: 'rejected', error: serializeError(error) }),
    );
    if (stallMs) {
      record('parent-stall-begin', { phase, requestedMs: stallMs });
      const stallBegin = performance.now();
      while (performance.now() - stallBegin < stallMs) {
        /* Deliberate parent-only event loop starvation. */
      }
      record('parent-stall-end', { phase, actualMs: performance.now() - stallBegin });
    }
    const result = await pending;
    const elapsedMs = performance.now() - begin;
    record('read-end', { phase, elapsedMs, ...result });
    const zeroTimerElapsedMs = await lagProbe;
    const after = liveness(child.pid);
    record('child-liveness', { phase, liveness: after });
    if (after.state !== 'present') throw new Error('Idle child not verified alive after read.');
    return { phase, elapsedMs, zeroTimerElapsedMs, before, after, ...result };
  };
  const baseline = await observe('idle-baseline', 0);
  if (
    baseline.outcome !== 'fulfilled' ||
    !Number.isSafeInteger(baseline.bytes) ||
    baseline.bytes <= 0
  )
    throw new Error(
      'Idle baseline unsuccessful; retain native outcome and do not interpret condition.',
    );
  record('cadence-wait-begin', { cadenceMs: 100 });
  await delay(100);
  const condition = await observe(
    options.condition,
    options.condition === 'parent-stall' ? 500 : 0,
  );
  observations = { baseline, condition };
} catch (error) {
  failure ??= error;
  record('witness-error', { error: serializeError(error) });
} finally {
  if (child) {
    record('cleanup-begin', { pid: child.pid ?? null, liveness: liveness(child.pid) });
    if (closeResult === undefined) child.kill('SIGKILL');
    await closed;
    const absence = liveness(child.pid);
    record('cleanup-end', {
      pid: child.pid ?? null,
      absence,
      closeResult,
      spawnError: serializeError(spawnError),
    });
    if (absence.state !== 'absent') failure ??= new Error('Child absence not proven.');
  }
  clearTimeout(watchdog);
  process.removeListener('SIGTERM', terminate);
  process.removeListener('SIGINT', terminate);
  if (signalReceived) failure ??= new Error(`Controller interrupted witness: ${signalReceived}`);
  const after = {
    head: git('rev-parse', 'HEAD'),
    status: git('status', '--porcelain'),
    sourceSha256: fileHash(join(candidate, sourcePath)),
    readerDistSha256: fileHash(join(candidate, builtPath)),
    coreEntrySha256: fileHash(coreResolvedPath),
    sources: sourcePaths.map((path) => ({ path, sha256: fileHash(join(candidate, path)) })),
  };
  if (
    after.head !== binding.head ||
    after.status !== '' ||
    after.sourceSha256 !== binding.sourceSha256 ||
    after.readerDistSha256 !== binding.readerDistSha256
  )
    failure ??= new Error('Candidate binding changed.');
  if (
    after.coreEntrySha256 !== binding.coreEntry.sha256 ||
    JSON.stringify(after.sources) !== JSON.stringify(binding.sources)
  )
    failure ??= new Error('Dependency or scheduling source binding changed.');
  const raw = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const rawPath = join(output, 'events.raw.jsonl');
  writeFileSync(rawPath, raw, { flag: 'wx' });
  const beforeStable = fileHash(rawPath);
  await delay(150);
  const afterStable = fileHash(rawPath);
  if (beforeStable !== afterStable)
    failure ??= new Error('Raw event log changed after child closure.');
  const receipt = {
    schema: 1,
    purpose: 'External mechanism diagnostic, outside owned test denominators.',
    utc: new Date().toISOString(),
    argv: process.argv,
    platform: process.platform,
    versions: process.versions,
    environment: {
      TMPDIR: process.env.TMPDIR ?? null,
      UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    },
    candidate,
    condition: options.condition,
    controls: {
      cadenceMs: 100,
      readerDeadlineMs: 250,
      windowsStartupMs: 5000,
      parentStallMs: options.condition === 'parent-stall' ? 500 : 0,
    },
    binding,
    after,
    observations: observations ?? null,
    child: {
      pid: child?.pid ?? null,
      closeResult: closeResult ?? null,
      finalLiveness: child ? liveness(child.pid) : null,
    },
    rawSha256: afterStable,
    rawStableWindowMs: 150,
    elapsedMs: performance.now() - started,
    failure: serializeError(failure),
    interpretation:
      'A late native AbortError may be correct fail-closed behavior. This controlled witness does not establish the main benchmark cause or require every late read to pass.',
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      output,
      failure: receipt.failure,
      observations: receipt.observations,
      rawSha256: afterStable,
    }) + '\n',
  );
  process.exitCode = failure ? 1 : 0;
}
