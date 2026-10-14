import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  createReadStream,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { constants } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import workerThreads, { threadId } from 'node:worker_threads';
import { prepareSource } from './coverage_configuration.mjs';

const active = Symbol.for('lorepack.nativeCoverageCollector');
const forkCollector = Symbol.for('lorepack.nativeForkCollector');
const commandCollector = Symbol.for('lorepack.nativeCommandCollector');
const syncCollector = Symbol.for('lorepack.nativeSyncCollector');
const capturedForkSpawn = Symbol.for('lorepack.capturedForkSpawn');
const capturedForkDispatch = Symbol.for('lorepack.capturedForkDispatch');
const campaignCollector = Symbol.for('lorepack.campaignCollector');
const capturedCommandSpawn = Symbol.for('lorepack.capturedCommandSpawn');
const capturedCommandLaunch = Symbol.for('lorepack.capturedCommandLaunch');
const compiledContexts = Symbol.for('lorepack.compiledCaptureContexts');
const imageCollectors = Symbol.for('lorepack.nativeImageCollectors');
const workerCollectors = Symbol.for('lorepack.nativeWorkerCollectors');
const variable = '__LOREPACK_NATIVE_COVERAGE__';
const campaignVariable = '__LOREPACK_CAMPAIGN_COVERAGE__';
function assertCoverageVariable(value) {
  if (value !== variable && value !== campaignVariable)
    throw new Error('Unsupported native counter namespace.');
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

function afterProcessExit(callback) {
  if (typeof process._exiting !== 'boolean')
    throw new Error('Native capture requires the verified Node exit state.');
  const emit = process.emit;
  process.emit = function (event, ...args) {
    const result = emit.call(this, event, ...args);
    if (this === process && event === 'exit' && process._exiting) callback(args[0]);
    return result;
  };
}

function recordUnregisteredNode(directory, kind, args) {
  const optionNames = [];
  const values = Array.isArray(args) ? args : [];
  for (const value of values[0] === process.execPath ? values.slice(1) : values) {
    if (typeof value !== 'string' || !/^--[a-z][a-z0-9-]*(?:=.*)?$/.test(value)) break;
    const name = value.split('=')[0];
    optionNames.push(name);
    if (name === '--eval' || name === '--print') break;
  }
  publish(directory, `${randomUUID()}.unregistered.json`, {
    schema: 1,
    provider: 'istanbul@4.1.11',
    kind,
    parentPid: process.pid,
    parentThreadId: threadId,
    argumentsSha256: digest(JSON.stringify(args)),
    optionNames,
  });
}

const nativeHeapDiagnostic =
  /^FATAL ERROR: [^\r\n]*Allocation failed - JavaScript heap out of memory\r?$/m;

function nativeHeapClosure(code, signal) {
  return (code === null && signal === 'SIGABRT') || (code === 134 && signal === null);
}

function observeHeapDiagnostic(stream) {
  let head = Buffer.alloc(0);
  let bytes = 0;
  const hash = createHash('sha256');
  if (stream) {
    const push = stream.push;
    stream.push = function (chunk, ...args) {
      if (chunk !== null) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, args[0]);
        bytes += data.length;
        hash.update(data);
        if (head.length < 64 * 1024)
          head = Buffer.concat([head, data.subarray(0, 64 * 1024 - head.length)]);
      }
      return push.call(this, chunk, ...args);
    };
  }
  return () => {
    const message = head.toString('utf8').match(nativeHeapDiagnostic)?.[0].replace(/\r$/, '');
    if (!message) return null;
    return {
      message,
      messageSha256: digest(message),
      stderrBytes: bytes,
      stderrSha256: hash.digest('hex'),
    };
  };
}

function validateHeapDiagnostic(record) {
  if (
    record?.cause !== 'v8-heap-oom' ||
    !Number.isSafeInteger(record.heapLimitMb) ||
    record.heapLimitMb < 64 ||
    record.heapLimitMb > 32768 ||
    typeof record.message !== 'string' ||
    record.message.includes('\n') ||
    !nativeHeapDiagnostic.test(record.message) ||
    record.messageSha256 !== digest(record.message) ||
    !Number.isSafeInteger(record.stderrBytes) ||
    record.stderrBytes < Buffer.byteLength(record.message) ||
    !/^[0-9a-f]{64}$/.test(record.stderrSha256)
  )
    throw new Error('Invalid native heap-abort diagnostic.');
}

export function registerForkCapture(entries, directory, audit = false) {
  const previous = globalThis[forkCollector];
  if (previous && !previous[campaignCollector])
    throw new Error('Fork capture is already registered.');
  const targets = new Map();
  for (const entry of entries) {
    const original = realpathSync(entry.original);
    const target = realpathSync(entry.target);
    if (
      digest(readFileSync(original)) !== entry.originalSha256 ||
      digest(readFileSync(target)) !== entry.targetSha256
    )
      throw new Error('Fork capture entrypoint differs from its receipt.');
    if (targets.has(original)) throw new Error('Duplicate fork capture entrypoint.');
    targets.set(original, { ...entry, original, target });
  }
  for (const entry of [...targets.values()]) {
    const registered = targets.get(entry.target);
    if (registered && registered.target !== entry.target)
      throw new Error('Ambiguous fork capture target.');
    if (!registered) targets.set(entry.target, entry);
  }
  mkdirSync(directory, { recursive: true });
  const originalFork = childProcess.fork;
  const pending = [];
  const launches = [];
  function measuredFork(...parameters) {
    const optionsIndex = Array.isArray(parameters[1]) || parameters[1] == null ? 2 : 1;
    const providedOptions = parameters[optionsIndex];
    if (providedOptions?.[capturedForkSpawn] || providedOptions?.[capturedForkDispatch])
      return originalFork.apply(this, parameters);
    let [modulePath, args, options] = parameters;
    let filename = modulePath instanceof URL ? fileURLToPath(modulePath) : resolve(modulePath);
    try {
      filename = realpathSync(filename);
    } catch {}
    const entry = targets.get(filename);
    if (!entry) {
      const forwarded = [...parameters];
      if (
        previous?.[campaignCollector] &&
        (providedOptions === undefined ||
          (providedOptions !== null &&
            typeof providedOptions === 'object' &&
            !Array.isArray(providedOptions)))
      )
        forwarded[optionsIndex] = { ...providedOptions, [capturedForkDispatch]: true };
      const child = originalFork.apply(this, forwarded);
      const captured = child[capturedCommandLaunch];
      if (audit && (captured?.directory !== resolve(directory) || captured.pid !== child.pid))
        recordUnregisteredNode(directory, 'fork', parameters.slice(0, 2));
      return child;
    }
    if (args != null && !Array.isArray(args)) {
      if (typeof args !== 'object') return originalFork.apply(this, parameters);
      options = args;
      args = [];
    }
    args ??= [];
    options ??= {};
    const stdio = options.stdio ?? (options.silent ? 'pipe' : 'inherit');
    const streams = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio, 'ipc'];
    if (streams.length !== 4 || streams[3] !== 'ipc')
      throw new Error('Fork capture requires the original four-descriptor IPC layout.');
    if (
      digest(readFileSync(entry.original)) !== entry.originalSha256 ||
      digest(readFileSync(entry.target)) !== entry.targetSha256
    )
      throw new Error('Fork capture entrypoint changed before launch.');
    const id = randomUUID();
    const capture = join(directory, `${id}.counters.jsonl`);
    const fd = openSync(capture, 'wx');
    let child;
    try {
      child = originalFork.call(this, entry.target, args, {
        ...options,
        [capturedForkSpawn]: true,
        stdio: [...streams, fd],
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const heapArguments = (options.execArgv ?? process.execArgv).filter((value) =>
      /^--max-old-space-size=[1-9][0-9]*$/.test(value),
    );
    const heapLimitMb = heapArguments.length === 1 ? Number(heapArguments[0].split('=')[1]) : null;
    const heapDiagnostic =
      entry.nativeHeapAbort === true ? observeHeapDiagnostic(child.stderr) : null;
    const record = {
      ...(entry.nativeHeapAbort === true ? { heapLimitMb } : {}),
      schema: 1,
      id,
      provider: 'istanbul@4.1.11',
      parentPid: process.pid,
      parentThreadId: threadId,
      pid: child.pid ?? null,
      original: entry.original,
      target: entry.target,
      originalSha256: entry.originalSha256,
      targetSha256: entry.targetSha256,
      environment:
        options.env === undefined
          ? 'inherited'
          : Object.keys(options.env).length
            ? 'explicit'
            : 'empty',
      argumentsSha256: digest(
        JSON.stringify({ args, execArgv: options.execArgv ?? process.execArgv }),
      ),
    };
    publish(directory, `${id}.launch.json`, record);
    launches.push(record);
    const kills = [];
    const kill = child.kill;
    child.kill = function (signal) {
      const result = kill.call(this, signal);
      kills.push({ signal: signal ?? 'SIGTERM', result });
      return result;
    };
    pending.push(
      new Promise((resolveClosed) => {
        child.prependOnceListener('close', (code, signal) => {
          closeSync(fd);
          let nativeAbort;
          if (heapDiagnostic && nativeHeapClosure(code, signal) && heapLimitMb !== null) {
            const diagnostic = heapDiagnostic();
            if (diagnostic) {
              const evidence = { ...record, code, signal, cause: 'v8-heap-oom', ...diagnostic };
              const filename = `${id}.native-abort.json`;
              publish(directory, filename, evidence);
              nativeAbort = { filename, sha256: digest(readFileSync(join(directory, filename))) };
            }
          }
          publish(directory, `${id}.close.json`, {
            ...record,
            code,
            signal,
            kills,
            ...(nativeAbort ? { nativeAbort } : {}),
          });
          resolveClosed();
        });
      }),
    );
    return child;
  }
  childProcess.fork = measuredFork;
  globalThis[forkCollector] = measuredFork;
  syncBuiltinESMExports();
  return {
    launches,
    async settled() {
      // A query deliberately unrefs its child; only capture finalization waits for close.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await Promise.all(pending);
      } finally {
        clearInterval(keepAlive);
      }
    },
    restore() {
      if (childProcess.fork !== measuredFork) throw new Error('Fork capture binding changed.');
      childProcess.fork = originalFork;
      if (previous) globalThis[forkCollector] = previous;
      else delete globalThis[forkCollector];
      syncBuiltinESMExports();
    },
  };
}

function assertNodeArguments(entry) {
  if (
    entry.captureDescriptor !== undefined &&
    (entry.captureDescriptor !== 5 || entry.captureMode === undefined)
  )
    throw new Error('Invalid command capture descriptor.');
  if (
    entry.captureMode !== undefined &&
    !['eval-import', 'script-import'].includes(entry.captureMode)
  )
    throw new Error('Invalid command capture launch mode.');
  if (entry.nodeArguments === undefined) return;
  if (
    !Array.isArray(entry.nodeArguments) ||
    entry.nodeArguments.some(
      (value) => typeof value !== 'string' || !/^--max-old-space-size=[1-9][0-9]*$/.test(value),
    )
  )
    throw new Error('Invalid command capture Node argument prefix.');
}

function validCaptureStreams(streams, entry) {
  if ((entry.captureDescriptor ?? 4) === 4)
    return (
      streams.length === 3 ||
      (streams.length === 4 &&
        (streams[3] === 'ipc' || (streams[3]?.type === 'pipe' && streams[3]?.ipc === true)))
    );
  return (
    streams.length === 5 &&
    (streams[3] === 'ignore' ||
      streams[3] === 'ipc' ||
      (streams[3]?.type === 'pipe' && streams[3]?.ipc === true)) &&
    (streams[4] === 'pipe' || (Number.isSafeInteger(streams[4]) && streams[4] >= 0))
  );
}

function selectCommand(registry, args, cwd, descriptor = 4) {
  if (!Array.isArray(args)) return null;
  const nodeArguments = [];
  let index = 0;
  for (; index < args.length; index++) {
    const argument = args[index];
    if (argument === '-' || argument === '-e' || argument === '--eval') {
      if (argument !== '-' && typeof args[index + 1] !== 'string') return null;
      const entry = [...registry.values()].find(
        (value) =>
          value.captureMode === 'eval-import' && (value.captureDescriptor ?? 4) === descriptor,
      );
      return entry ? { entry, index: -1 } : null;
    }
    if (
      [
        '--import',
        '--allow-fs-read',
        '--allow-fs-write',
        '--require',
        '--conditions',
        '-r',
        '-C',
      ].includes(argument)
    ) {
      if (typeof args[index + 1] !== 'string' || !args[index + 1]) return null;
      if (argument !== '--import') nodeArguments.push(argument, args[index + 1]);
      index++;
      continue;
    }
    if (
      typeof argument === 'string' &&
      /^(?:--permission|--no-warnings|--experimental-import-meta-resolve|--(?:import|allow-fs-read|allow-fs-write|require|conditions)=.+|--input-type=(?:module|commonjs)|--max-old-space-size=[1-9][0-9]*)$/.test(
        argument,
      )
    ) {
      if (!argument.startsWith('--import=')) nodeArguments.push(argument);
      continue;
    }
    if (typeof argument !== 'string' || argument.startsWith('-')) return null;
    break;
  }
  if (index >= args.length) return null;
  let filename = resolve(cwd ?? process.cwd(), args[index]);
  try {
    filename = realpathSync(filename);
  } catch {}
  const entry = registry.get(filename);
  if (!entry) {
    const preload = [...registry.values()].find(
      (value) =>
        value.captureMode === 'script-import' && (value.captureDescriptor ?? 4) === descriptor,
    );
    if (!preload) return null;
    try {
      if (!statSync(filename).isFile()) return null;
    } catch {
      return null;
    }
    return { entry: preload, index: -1 };
  }
  if (index && !isDeepStrictEqual(nodeArguments, entry.nodeArguments ?? [])) return null;
  return { entry, index };
}

export function registerCommandCapture(entries, directory, audit = false) {
  const previous = globalThis[commandCollector];
  if (previous && !previous[campaignCollector])
    throw new Error('Command capture is already registered.');
  const targets = new Map();
  for (const entry of entries) {
    assertNodeArguments(entry);
    const original = realpathSync(entry.original);
    const target = realpathSync(entry.target);
    if (
      digest(readFileSync(original)) !== entry.originalSha256 ||
      digest(readFileSync(target)) !== entry.targetSha256
    )
      throw new Error('Command capture entrypoint differs from its receipt.');
    if (targets.has(original)) throw new Error('Duplicate command capture entrypoint.');
    targets.set(original, { ...entry, original, target });
  }
  mkdirSync(directory, { recursive: true });
  const prototype = childProcess.ChildProcess.prototype;
  const originalSpawn = prototype.spawn;
  const node = realpathSync(process.execPath);
  const pending = [];
  const launches = [];
  function measuredSpawn(options) {
    if (options.file !== process.execPath && options.file !== node)
      return originalSpawn.call(this, options);
    if (options[capturedForkSpawn] || options[capturedCommandSpawn])
      return originalSpawn.call(this, options);
    const selected = selectCommand(
      targets,
      options.args?.slice(1),
      options.cwd,
      Array.isArray(options.stdio) && options.stdio.length === 5 ? 5 : 4,
    );
    if (!selected) {
      if (audit && !['--version', '--help'].includes(options.args?.[1]))
        recordUnregisteredNode(directory, 'async', options.args);
      return originalSpawn.call(this, options);
    }
    const { entry, index } = selected;
    if (
      digest(readFileSync(entry.original)) !== entry.originalSha256 ||
      digest(readFileSync(entry.target)) !== entry.targetSha256
    )
      throw new Error('Command capture entrypoint changed before launch.');
    const stdio = options.stdio ?? 'pipe';
    const streams = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
    if (!validCaptureStreams(streams, entry))
      throw new Error('Command capture requires the original three-descriptor layout.');
    const id = randomUUID();
    const fd = openSync(join(directory, `${id}.counters.jsonl`), 'wx');
    let result;
    try {
      result = originalSpawn.call(this, {
        ...options,
        [capturedCommandSpawn]: true,
        args:
          index === -1
            ? [
                options.args[0],
                '--import',
                pathToFileURL(entry.target).href,
                ...options.args.slice(1),
              ]
            : [...options.args.slice(0, index + 1), entry.target, ...options.args.slice(index + 2)],
        stdio: [...streams, ...(streams.length === 3 ? ['ignore'] : []), fd],
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    if (Array.isArray(this.stdio)) this.stdio = this.stdio.slice(0, streams.length);
    const record = {
      schema: 1,
      id,
      provider: 'istanbul@4.1.11',
      parentPid: process.pid,
      parentThreadId: threadId,
      pid: this.pid ?? null,
      original: entry.original,
      target: entry.target,
      originalSha256: entry.originalSha256,
      targetSha256: entry.targetSha256,
      ...(entry.captureMode ? { captureMode: entry.captureMode } : {}),
      ...(entry.captureDescriptor ? { captureDescriptor: entry.captureDescriptor } : {}),
      environment: 'normalized',
      argumentsSha256: digest(JSON.stringify(options.args)),
    };
    publish(directory, `${id}.launch.json`, record);
    this[capturedCommandLaunch] = { directory: resolve(directory), pid: this.pid, id };
    launches.push(record);
    const kills = [];
    const kill = this.kill;
    this.kill = function (signal) {
      const killed = kill.call(this, signal);
      kills.push({ signal: signal ?? 'SIGTERM', result: killed });
      return killed;
    };
    pending.push(
      new Promise((resolveClosed) => {
        this.prependOnceListener('close', (code, signal) => {
          closeSync(fd);
          publish(directory, `${id}.close.json`, { ...record, code, signal, kills });
          resolveClosed();
        });
      }),
    );
    return result;
  }
  prototype.spawn = measuredSpawn;
  globalThis[commandCollector] = measuredSpawn;
  return {
    launches,
    async settled() {
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await Promise.all(pending);
      } finally {
        clearInterval(keepAlive);
      }
    },
    restore() {
      if (prototype.spawn !== measuredSpawn) throw new Error('Command capture binding changed.');
      prototype.spawn = originalSpawn;
      if (previous) globalThis[commandCollector] = previous;
      else delete globalThis[commandCollector];
    },
  };
}

export function registerSyncCommandCapture(entries, directory, audit = false) {
  const previous = globalThis[syncCollector];
  if (previous && !previous[campaignCollector])
    throw new Error('Synchronous capture is already registered.');
  const registry = new Map();
  for (const entry of entries) {
    assertNodeArguments(entry);
    const original = realpathSync(entry.original),
      target = realpathSync(entry.target);
    if (
      registry.has(original) ||
      digest(readFileSync(original)) !== entry.originalSha256 ||
      digest(readFileSync(target)) !== entry.targetSha256
    )
      throw new Error('Invalid synchronous capture entrypoint');
    registry.set(original, { ...entry, original, target });
  }
  mkdirSync(directory, { recursive: true });
  const originals = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync };
  const launches = [];
  function select(file, args, options) {
    if (file !== process.execPath || options?.[capturedCommandSpawn]) return null;
    const selected = selectCommand(
      registry,
      args,
      options?.cwd,
      Array.isArray(options?.stdio) && options.stdio.length === 5 ? 5 : 4,
    );
    if (!selected && audit && !['--version', '--help'].includes(args?.[0]))
      recordUnregisteredNode(directory, 'sync', args);
    return selected;
  }
  function measured(selected, args, options) {
    const { entry, index } = selected;
    if (options.shell) throw new Error('Synchronous capture does not support shell entrypoints');
    if (
      digest(readFileSync(entry.original)) !== entry.originalSha256 ||
      digest(readFileSync(entry.target)) !== entry.targetSha256
    )
      throw new Error('Synchronous capture entrypoint changed before launch');
    const stdio = options.stdio ?? 'pipe';
    const streams = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
    if (!validCaptureStreams(streams, entry))
      throw new Error('Synchronous capture requires three original descriptors');
    const id = randomUUID();
    const fd = openSync(join(directory, `${id}.counters.jsonl`), 'wx');
    let result;
    try {
      result = originals.spawnSync(
        process.execPath,
        index === -1
          ? ['--import', pathToFileURL(entry.target).href, ...args]
          : [...args.slice(0, index), entry.target, ...args.slice(index + 1)],
        {
          ...options,
          [capturedCommandSpawn]: true,
          stdio: [...streams, ...(streams.length === 3 ? ['ignore'] : []), fd],
        },
      );
    } finally {
      closeSync(fd);
    }
    if (Array.isArray(result.output)) result.output = result.output.slice(0, streams.length);
    if (result.error?.spawnargs) result.error.spawnargs = [...args];
    const record = {
      schema: 1,
      id,
      provider: 'istanbul@4.1.11',
      parentPid: process.pid,
      parentThreadId: threadId,
      pid: result.pid,
      original: entry.original,
      target: entry.target,
      originalSha256: entry.originalSha256,
      targetSha256: entry.targetSha256,
      ...(entry.captureMode ? { captureMode: entry.captureMode } : {}),
      ...(entry.captureDescriptor ? { captureDescriptor: entry.captureDescriptor } : {}),
      environment:
        options.env === undefined
          ? 'inherited'
          : Object.keys(options.env).length
            ? 'explicit'
            : 'empty',
      argumentsSha256: digest(JSON.stringify(args)),
      nativeErrorCode: result.error?.code ?? null,
    };
    const nativeStopped =
      result.signal !== null && ['ETIMEDOUT', 'ENOBUFS'].includes(record.nativeErrorCode);
    const nativeStop = nativeStopped
      ? { cause: record.nativeErrorCode, signal: options.killSignal ?? 'SIGTERM' }
      : null;
    publish(directory, `${id}.launch.json`, record);
    publish(directory, `${id}.close.json`, {
      ...record,
      code: result.status,
      signal: result.signal,
      kills: [],
      nativeStop,
    });
    launches.push(record);
    return result;
  }
  function spawn(...parameters) {
    const [file, args, options] = parameters;
    const entry = select(file, args, options);
    return entry
      ? measured(entry, args, options ?? {})
      : originals.spawnSync.apply(this, parameters);
  }
  function exec(...parameters) {
    let [file, args, options] = parameters;
    const entry = select(file, args, options);
    if (!entry) return originals.execFileSync.apply(this, parameters);
    options ??= {};
    const result = measured(entry, args, options);
    if (!options.stdio && result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw Object.assign(result.error, result);
    if (result.status !== 0) {
      let message = `Command failed: ${[options.argv0 || file, ...args].join(' ')}`;
      if (result.stderr?.length) message += `\n${result.stderr.toString()}`;
      throw Object.assign(new Error(message), result);
    }
    return result.stdout;
  }
  childProcess.spawnSync = spawn;
  childProcess.execFileSync = exec;
  globalThis[syncCollector] = spawn;
  syncBuiltinESMExports();
  return {
    launches,
    restore() {
      if (childProcess.spawnSync !== spawn || childProcess.execFileSync !== exec)
        throw new Error('Synchronous capture binding changed');
      Object.assign(childProcess, originals);
      if (previous) globalThis[syncCollector] = previous;
      else delete globalThis[syncCollector];
      syncBuiltinESMExports();
    },
  };
}

function digestFile(filename, buffer) {
  const descriptor = openSync(filename, 'r');
  const hash = createHash('sha256');
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function verifyArtifactGraph(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error('Native CLI artifact graph is missing.');
  const paths = new Set();
  const buffer = Buffer.alloc(64 * 1024);
  for (const artifact of artifacts) {
    if (paths.has(artifact.path) || digestFile(artifact.path, buffer) !== artifact.sha256)
      throw new Error('Native CLI artifact differs from its receipt.');
    paths.add(artifact.path);
  }
}

export function createCampaignRegistry(snapshot, launch) {
  verifyArtifactGraph(launch.artifacts);
  const root = realpathSync(snapshot.root);
  if (
    launch.schema !== 1 ||
    launch.provider !== 'istanbul@4.1.11' ||
    digest(readFileSync(launch.entry)) !== launch.entrySha256 ||
    digest(readFileSync(launch.entrypoint)) !== launch.entrypointSha256
  )
    throw new Error('Campaign CLI launch differs from its receipt.');
  const alias = (path, target) => {
    const original = realpathSync(join(root, path));
    return { ...target, original, originalSha256: digest(readFileSync(original)) };
  };
  const forkEntries = [...launch.forkEntries];
  for (const entry of launch.forkEntries) {
    const filename = basename(entry.target);
    const compiled =
      filename === 'parse-child.js'
        ? 'packages/parsers/dist/parse-child.js'
        : filename === 'query-child.js'
          ? 'packages/backend-local/dist/sql/query-child.js'
          : null;
    if (!compiled) throw new Error('Unknown campaign fork target.');
    forkEntries.push(alias(compiled, entry), alias(`packages/cli/dist/${filename}`, entry));
  }
  const commandEntries = [...launch.commandEntries];
  for (const entry of launch.commandEntries) {
    if (entry.captureMode === 'eval-import' || entry.captureMode === 'script-import') continue;
    if (basename(entry.target) !== 'archive-verify-child.js')
      throw new Error('Unknown campaign command target.');
    commandEntries.push(
      alias('packages/backend-local/dist/archive-verify-child.js', entry),
      alias('packages/cli/dist/archive-verify-child.js', entry),
    );
  }
  const cli = {
    original: launch.entry,
    target: launch.entry,
    originalSha256: launch.entrySha256,
    targetSha256: launch.entrySha256,
    interruptionSignals: ['SIGTERM', 'SIGKILL'],
  };
  commandEntries.push(
    cli,
    alias('packages/cli/dist/entry.js', cli),
    alias('packages/cli/dist/public-entry.js', cli),
  );
  return { forkEntries, commandEntries };
}

export function registerCampaignCapture(snapshot, launch) {
  const registry = createCampaignRegistry(snapshot, launch);
  const captures = [];
  try {
    captures.push(registerForkCapture(registry.forkEntries, launch.captureDirectory, true));
    captures.push(registerCommandCapture(registry.commandEntries, launch.captureDirectory, true));
    captures.push(
      registerSyncCommandCapture(registry.commandEntries, launch.captureDirectory, true),
    );
  } catch (error) {
    for (const capture of captures.reverse()) capture.restore();
    throw error;
  }
  for (const key of [forkCollector, commandCollector, syncCollector])
    globalThis[key][campaignCollector] = true;
  return {
    registry,
    async settled() {
      await Promise.all(
        captures.filter((capture) => capture.settled).map((capture) => capture.settled()),
      );
    },
    restore() {
      for (const capture of [...captures].reverse()) capture.restore();
    },
  };
}

export async function reconcileForkCapture(snapshot, directory, entries, direct = {}) {
  const registry = new Map();
  for (const entry of entries) {
    const original = realpathSync(entry.original);
    const target = realpathSync(entry.target);
    if (
      registry.has(original) ||
      digest(readFileSync(original)) !== entry.originalSha256 ||
      digest(readFileSync(target)) !== entry.targetSha256 ||
      !Array.isArray(entry.interruptionSignals) ||
      entry.interruptionSignals.some((signal) => typeof signal !== 'string')
    )
      throw new Error('Invalid fork reconciliation entrypoint.');
    registry.set(original, { ...entry, original, target });
  }
  const files = readdirSync(directory).sort();
  const unregistered = files
    .filter((file) => file.endsWith('.unregistered.json'))
    .map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')));
  for (const record of unregistered) {
    if (
      record.schema !== 1 ||
      record.provider !== 'istanbul@4.1.11' ||
      !['fork', 'async', 'sync'].includes(record.kind) ||
      !Number.isSafeInteger(record.parentPid) ||
      record.parentPid <= 0 ||
      !Number.isSafeInteger(record.parentThreadId) ||
      record.parentThreadId < 0 ||
      !/^[0-9a-f]{64}$/.test(record.argumentsSha256) ||
      !Array.isArray(record.optionNames) ||
      record.optionNames.some(
        (value) => typeof value !== 'string' || !/^--[a-z][a-z0-9-]*$/.test(value),
      )
    )
      throw new Error('Invalid unregistered Node launch evidence.');
  }
  if (unregistered.length)
    throw Object.assign(
      new Error(
        `Unregistered Node launches prevent native qualification: ${unregistered.map((record) => `${record.kind} ${record.optionNames.join(',')}`).join('; ')}`,
      ),
      { unregistered },
    );
  const consumed = new Set();
  const identities = new Set();
  const executions = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const file of files) {
    if (!file.endsWith('.launch.json')) continue;
    const launch = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (
      launch.schema !== 1 ||
      launch.provider !== 'istanbul@4.1.11' ||
      !uuid.test(launch.id) ||
      file !== `${launch.id}.launch.json` ||
      !Number.isSafeInteger(launch.pid) ||
      launch.pid <= 0 ||
      !Number.isSafeInteger(launch.parentPid) ||
      launch.parentPid <= 0 ||
      !Number.isSafeInteger(launch.parentThreadId) ||
      launch.parentThreadId < 0 ||
      !['inherited', 'explicit', 'empty', 'normalized'].includes(launch.environment) ||
      !/^[0-9a-f]{64}$/.test(launch.argumentsSha256)
    )
      throw new Error(`Invalid fork launch receipt: ${file}`);
    const entry = registry.get(launch.original);
    if (!entry) throw new Error(`Unregistered fork launch: ${file}`);
    for (const key of [
      'original',
      'target',
      'originalSha256',
      'targetSha256',
      'captureMode',
      'captureDescriptor',
    ])
      if (entry[key] !== launch[key]) throw new Error(`Fork entrypoint receipt differs: ${file}`);
    const closeFile = `${launch.id}.close.json`;
    const counterFile = `${launch.id}.counters.jsonl`;
    if (!files.includes(closeFile) || !files.includes(counterFile))
      throw new Error(`Missing fork close receipt or counters: ${launch.id}`);
    const { code, signal, kills, nativeStop, nativeAbort, ...identity } = JSON.parse(
      readFileSync(join(directory, closeFile), 'utf8'),
    );
    if (
      !isDeepStrictEqual(identity, launch) ||
      !Array.isArray(kills) ||
      kills.some(
        (kill) =>
          (typeof kill?.signal !== 'string' && !Number.isSafeInteger(kill?.signal)) ||
          typeof kill?.result !== 'boolean',
      )
    )
      throw new Error(`Fork close identity or kill receipt differs: ${closeFile}`);
    if (
      nativeStop != null &&
      (!['ETIMEDOUT', 'ENOBUFS'].includes(nativeStop.cause) ||
        nativeStop.cause !== launch.nativeErrorCode ||
        (nativeStop.signal !== signal && nativeStop.signal !== constants.signals[signal]))
    )
      throw new Error(`Native synchronous termination evidence differs: ${closeFile}`);
    let heapAbort = null;
    if (nativeAbort != null) {
      const expected = `${launch.id}.native-abort.json`;
      if (
        entry.nativeHeapAbort !== true ||
        nativeAbort.filename !== expected ||
        !files.includes(expected) ||
        !nativeHeapClosure(code, signal) ||
        nativeStop != null ||
        kills.length
      )
        throw new Error('Unqualified native heap abort.');
      const bytes = readFileSync(join(directory, expected));
      if (nativeAbort.sha256 !== digest(bytes))
        throw new Error('Native heap-abort evidence hash differs.');
      const {
        cause,
        message,
        messageSha256,
        stderrBytes,
        stderrSha256,
        code: observedCode,
        signal: observedSignal,
        ...observed
      } = JSON.parse(bytes);
      if (
        !isDeepStrictEqual(observed, launch) ||
        observedCode !== code ||
        observedSignal !== signal
      )
        throw new Error('Native heap-abort identity differs.');
      heapAbort = {
        cause,
        heapLimitMb: launch.heapLimitMb,
        message,
        messageSha256,
        stderrBytes,
        stderrSha256,
      };
      validateHeapDiagnostic(heapAbort);
      consumed.add(expected);
    }
    const counters = await replayCounterFile(snapshot, join(directory, counterFile), {
      pid: launch.pid,
      threadId: 0,
      code,
      signal,
      ...(heapAbort ? { nativeAbort: heapAbort } : {}),
    });
    if (identities.has(counters.id) || counters.pid !== launch.pid || counters.threadId !== 0)
      throw new Error(`Repeated or mismatched fork execution: ${counterFile}`);
    identities.add(counters.id);
    if (heapAbort) {
      if (counters.state !== 'interrupted')
        throw new Error('Native heap abort has a JavaScript completion.');
    } else if (signal === null) {
      if (
        !['completed', 'replaced'].includes(counters.state) ||
        !Number.isSafeInteger(code) ||
        (counters.state === 'completed' && code !== counters.exitCode)
      )
        throw new Error(`Fork completion differs from close: ${closeFile}`);
    } else if (
      code !== null ||
      !entry.interruptionSignals.includes(signal) ||
      (nativeStop == null &&
        !kills.some(
          (kill) =>
            kill.result === true &&
            (kill.signal === signal || kill.signal === constants.signals[signal]),
        ))
    )
      throw new Error(`Unqualified fork interruption: ${closeFile}`);
    for (const name of [file, closeFile, counterFile]) consumed.add(name);
    executions.push({
      ...counters,
      counterState: counters.state,
      counterExitCode: counters.exitCode,
      state: heapAbort || signal !== null ? 'interrupted' : 'completed',
      ...(heapAbort ? { nativeAbort: heapAbort } : {}),
      exitCode: code,
      launchId: launch.id,
      signal,
    });
  }
  if (!executions.length || consumed.size !== files.length)
    throw new Error('Missing fork launches or orphaned capture records.');
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve('@vitest/coverage-istanbul'));
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
  const { captureCoverage } = await import('./coverage_report.mjs');
  const { remapNativeCoverage } = await import('@vitest/coverage-istanbul/dist/provider.js');
  const merged = createCoverageMap({});
  for (const execution of executions) {
    const remapped = await remapNativeCoverage(createCoverageMap(structuredClone(execution.maps)));
    const wire = JSON.parse(JSON.stringify(remapped.toJSON()));
    captureCoverage(snapshot, wire, execution.id);
    const maps = Object.fromEntries(
      Object.entries(wire).map(([filename, map]) => {
        const canonical = realpathSync(filename);
        return [canonical, { ...map, path: canonical }];
      }),
    );
    if (!isDeepStrictEqual(Object.keys(maps).sort(), Object.keys(execution.maps).sort()))
      throw new Error(`Fork remapping lost loaded sources: ${execution.id}`);
    for (const [filename, map] of Object.entries(maps)) {
      const previous = [direct[filename]];
      if (merged.files().includes(filename))
        previous.push(merged.fileCoverageFor(filename).toJSON());
      for (const prior of previous.filter(Boolean))
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(prior[field], map[field]))
            throw new Error(`Fork coverage layout differs: ${filename}.${field}`);
    }
    merged.merge(maps);
  }
  return {
    status: 'Pass',
    processes: executions.length,
    executions: executions.map(({ maps, ...execution }) => execution),
    maps: JSON.parse(JSON.stringify(merged.toJSON())),
  };
}

export async function runCapturedCli(
  entrypoint,
  entries,
  directory,
  commandEntries = [],
  entrypointSha256,
  artifacts,
) {
  if (artifacts !== undefined) verifyArtifactGraph(artifacts);
  if (entrypointSha256 !== undefined && digest(readFileSync(entrypoint)) !== entrypointSha256)
    throw new Error('Captured CLI entrypoint differs from its receipt.');
  const capture = registerForkCapture(entries, directory);
  let commands;
  try {
    commands = registerCommandCapture(commandEntries, directory);
  } catch (error) {
    capture.restore();
    throw error;
  }
  const exit = process.exit;
  class ExitRequest extends Error {
    constructor(parameters) {
      super('Native CLI requested process exit.');
      this.parameters = parameters;
    }
  }
  process.exit = (...parameters) => {
    throw new ExitRequest(parameters);
  };
  let parameters = [];
  let failure;
  try {
    await import(pathToFileURL(entrypoint).href);
  } catch (error) {
    if (error instanceof ExitRequest) parameters = error.parameters;
    else failure = error;
  } finally {
    process.exit = exit;
  }
  try {
    await Promise.all([capture.settled(), commands.settled()]);
  } finally {
    try {
      commands.restore();
    } finally {
      capture.restore();
    }
  }
  if (failure) throw failure;
  exit.apply(process, parameters);
}

export async function buildNativeCli(snapshot, preparations, output, coverageVariable = variable) {
  assertCoverageVariable(coverageVariable);
  const root = realpathSync(snapshot.root);
  const directory = resolve(output);
  if (directory === join(root, 'packages', 'cli', 'dist'))
    throw new Error('Native measurement cannot overwrite ordinary CLI artifacts.');
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('Native measurement output must be empty.');
  const cli = join(root, 'packages', 'cli');
  cpSync(join(cli, 'package.json'), join(dirname(directory), 'package.json'), {
    errorOnExist: true,
    force: false,
  });
  cpSync(join(cli, 'studio-dist'), join(dirname(directory), 'studio-dist'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  symlinkSync(join(cli, 'node_modules'), join(dirname(directory), 'node_modules'), 'junction');
  const { bundleCli } = await import('./bundle-cli.mjs');
  const compilation = compiledCapturePlugin(snapshot, preparations, coverageVariable);
  await bundleCli({
    root,
    output: directory,
    plugins: [compilation.plugin],
  });
  const initialization = join(directory, 'capture-bootstrap.mjs');
  writeFileSync(
    initialization,
    `import {registerCounterStream} from ${JSON.stringify(import.meta.url)};registerCounterStream(4,${JSON.stringify(coverageVariable)});\n`,
    { flag: 'wx' },
  );
  for (const filename of [
    'public-entry.js',
    'public-index.js',
    'query-child.js',
    'parse-child.js',
    'archive-verify-child.js',
  ]) {
    const body = `measurement-${filename}`;
    renameSync(join(directory, filename), join(directory, body));
    writeFileSync(
      join(directory, filename),
      `import './capture-bootstrap.mjs';export * from './${body}';\n`,
      { flag: 'wx' },
    );
  }
  const importEntries = [
    createEvalCapture(
      snapshot,
      preparations,
      join(directory, 'capture-eval.mjs'),
      'eval-import',
      coverageVariable,
    ),
    createEvalCapture(
      snapshot,
      preparations,
      join(directory, 'capture-script.mjs'),
      'script-import',
      coverageVariable,
    ),
    createEvalCapture(
      snapshot,
      preparations,
      join(directory, 'capture-eval-fd5.mjs'),
      'eval-import',
      coverageVariable,
      5,
    ),
    createEvalCapture(
      snapshot,
      preparations,
      join(directory, 'capture-script-fd5.mjs'),
      'script-import',
      coverageVariable,
      5,
    ),
  ];
  const artifacts = readdirSync(directory)
    .filter((filename) => /\.(?:m?js|js\.map)$/.test(filename))
    .sort()
    .map((filename) => {
      const path = join(directory, filename);
      return { path, sha256: digest(readFileSync(path)) };
    });
  const receipts = [...compilation.receipts.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (!receipts.length) throw new Error('Native CLI build produced no owned compilation receipts.');
  publish(directory, 'compilation.receipts.json', {
    schema: 1,
    provider: 'istanbul@4.1.11',
    receipts,
  });
  const childEntry = (filename) => {
    const target = join(directory, filename);
    const hash = digest(readFileSync(target));
    return {
      original: target,
      target,
      originalSha256: hash,
      targetSha256: hash,
      interruptionSignals: ['SIGKILL'],
      ...(filename === 'parse-child.js' ? { nativeHeapAbort: true } : {}),
    };
  };
  const forkEntries = ['parse-child.js', 'query-child.js'].map(childEntry);
  const commandEntries = [
    { ...childEntry('archive-verify-child.js'), nodeArguments: ['--max-old-space-size=128'] },
    ...importEntries,
  ];
  const entry = join(directory, 'capture-entry.mjs');
  const captureDirectory = join(directory, 'captures');
  const entrypoint = join(directory, 'public-entry.js');
  const entrypointSha256 = digest(readFileSync(entrypoint));
  const bootstrap = `import {runCapturedCli} from ${JSON.stringify(import.meta.url)}; await runCapturedCli(${JSON.stringify(entrypoint)},${JSON.stringify(forkEntries)},${JSON.stringify(captureDirectory)},${JSON.stringify(commandEntries)},${JSON.stringify(entrypointSha256)},${JSON.stringify(artifacts)});\n`;
  writeFileSync(entry, bootstrap, { flag: 'wx' });
  const launch = {
    schema: 1,
    provider: 'istanbul@4.1.11',
    entry,
    entrySha256: digest(bootstrap),
    entrypoint,
    entrypointSha256,
    artifacts,
    captureDirectory,
    forkEntries,
    commandEntries,
  };
  publish(directory, 'launch.receipts.json', launch);
  return { directory, receipts, launch };
}

export function compiledCaptureReader(snapshot, preparations, coverageVariable = variable) {
  assertCoverageVariable(coverageVariable);
  const root = realpathSync(snapshot.root);
  const artifacts = new Map(
    snapshot.included
      .filter((entry) => /\.tsx?$/.test(entry.path))
      .map((entry) => {
        const compiled = entry.path.includes('/src/')
          ? entry.path.replace('/src/', '/dist/')
          : `dist/${entry.path}`;
        return [join(root, compiled.replace(/\.tsx?$/, '.js')), entry];
      }),
  );
  for (const entry of snapshot.included.filter((value) => /\.m?js$/.test(value.path)))
    artifacts.set(join(root, entry.path), { ...entry, raw: true });
  const receipts = new Map();
  return {
    receipts,
    load(path) {
      const filename = resolve(path);
      const entry = artifacts.get(filename);
      if (!entry) {
        if (/^packages\/[^/]+\/dist\//.test(relative(root, filename).split(sep).join('/')))
          throw new Error(`Unowned compiled capture input: ${filename}`);
        return;
      }
      const bytes = readFileSync(filename);
      let mapBytes = null;
      let map = null;
      let source = filename;
      if (entry.raw) {
        if (digest(bytes) !== entry.sha256)
          throw new Error(`Owned script source differs from inventory: ${filename}`);
      } else {
        mapBytes = readFileSync(`${filename}.map`);
        map = JSON.parse(mapBytes.toString('utf8'));
        if (
          map.version !== 3 ||
          map.file !== basename(filename) ||
          !Array.isArray(map.sources) ||
          map.sources.length !== 1 ||
          typeof map.sources[0] !== 'string' ||
          typeof map.mappings !== 'string'
        )
          throw new Error(`Unsupported compiled capture map: ${filename}`);
        source = map.sources[0].startsWith('file:')
          ? fileURLToPath(map.sources[0])
          : resolve(dirname(filename), map.sourceRoot ?? '', map.sources[0]);
        if (source !== join(root, entry.path))
          throw new Error(`Compiled capture mapped source differs: ${filename}`);
      }
      const prepared = JSON.parse(
        readFileSync(join(preparations, `${digest(entry.path)}.json`), 'utf8'),
      );
      const expected = prepareSource(snapshot, source, prepared.code, prepared.map);
      for (const key of ['schema', 'kind', 'provider', 'path', 'sha256'])
        if (prepared[key] !== expected[key])
          throw new Error(`Compiled preparation identity differs: ${entry.path}`);
      if (
        prepared.coverageVariable !== coverageVariable ||
        typeof prepared.instrumentedCode !== 'string' ||
        digest(prepared.instrumentedCode) !== prepared.instrumentedSha256
      )
        throw new Error(`Compiled instrumented preparation differs: ${entry.path}`);
      if (
        map?.sourcesContent != null &&
        (!Array.isArray(map.sourcesContent) ||
          map.sourcesContent.length !== 1 ||
          map.sourcesContent[0] !== readFileSync(source, 'utf8'))
      )
        throw new Error(`Compiled capture mapped content differs: ${filename}`);
      const receipt = {
        path: entry.path,
        sha256: entry.sha256,
        artifact: filename,
        artifactSha256: digest(bytes),
        artifactMapSha256: mapBytes === null ? null : digest(mapBytes),
        instrumentedSha256: prepared.instrumentedSha256,
      };
      if (receipts.has(filename) && !isDeepStrictEqual(receipts.get(filename), receipt))
        throw new Error(`Compiled input changed between loads: ${filename}`);
      receipts.set(filename, receipt);
      return {
        contents: prepared.instrumentedCode,
        loader: 'js',
        resolveDir: dirname(filename),
      };
    },
  };
}

export function compiledCapturePlugin(snapshot, preparations, coverageVariable = variable) {
  const reader = compiledCaptureReader(snapshot, preparations, coverageVariable);
  return {
    receipts: reader.receipts,
    plugin: {
      name: 'source-bound-compiled-capture',
      setup(builder) {
        builder.onLoad({ filter: /\.js$/ }, (args) => reader.load(args.path));
      },
    },
  };
}

export function createEvalCapture(
  snapshot,
  preparations,
  filename,
  captureMode = 'eval-import',
  coverageVariable = variable,
  descriptor = 4,
) {
  assertCoverageVariable(coverageVariable);
  if (![4, 5].includes(descriptor)) throw new Error('Invalid import capture descriptor.');
  if (!['eval-import', 'script-import'].includes(captureMode))
    throw new Error('Invalid import capture mode.');
  const bootstrap = `import {registerCompiledCapture} from ${JSON.stringify(import.meta.url)};
if(process.execArgv[0]!=='--import'||process.execArgv[1]!==import.meta.url)throw new Error('Eval capture preload arguments differ.');
process.execArgv.splice(0,2);
registerCompiledCapture(${JSON.stringify(snapshot)},${JSON.stringify(preparations)},${descriptor},${JSON.stringify(coverageVariable)});
`;
  writeFileSync(filename, bootstrap, { flag: 'wx' });
  const target = realpathSync(filename),
    hash = digest(bootstrap);
  return {
    original: target,
    target,
    originalSha256: hash,
    targetSha256: hash,
    captureMode,
    ...(descriptor === 5 ? { captureDescriptor: descriptor } : {}),
    interruptionSignals: ['SIGTERM', 'SIGKILL'],
  };
}

export function registerCompiledCapture(snapshot, preparations, fd, coverageVariable = variable) {
  const reader = compiledCaptureReader(snapshot, preparations, coverageVariable);
  registerCounterStream(fd, coverageVariable);
  globalThis[compiledContexts] ??= new Map();
  const contexts = globalThis[compiledContexts];
  const captureContext = { snapshot, preparations, coverageVariable, generated: new Map() };
  contexts.set(coverageVariable, captureContext);
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const address = new URL(url);
      const filename = fileURLToPath(address);
      const graphs = [...contexts.values()]
        .map((registered) => registered.generated.get(filename))
        .filter(Boolean);
      if (graphs.length > 1) throw new Error('Generated capture graph has multiple owners.');
      const graph = graphs[0];
      if (graph) {
        if (address.search || address.hash)
          throw new Error('Unsupported generated capture URL variant.');
        const buffer = Buffer.alloc(64 * 1024);
        for (const [artifact, sha256] of graph.artifacts)
          if (digestFile(artifact, buffer) !== sha256)
            throw new Error('Generated capture artifact changed before load.');
        for (const [input, sha256] of graph.inputs)
          if (digestFile(input, buffer) !== sha256)
            throw new Error('Generated capture input changed before load.');
        const loaded = nextLoad(url, context);
        if (
          loaded.format !== 'module' ||
          loaded.source == null ||
          digest(Buffer.from(loaded.source)) !== graph.artifacts.get(filename)
        )
          throw new Error('Loaded generated source differs from its receipt.');
        return loaded;
      }
      const prepared = reader.load(filename);
      if (!prepared) return nextLoad(url, context);
      if (address.search || address.hash)
        throw new Error('Unsupported compiled capture URL variant.');
      const loaded = nextLoad(url, context);
      const receipt = reader.receipts.get(filename);
      if (
        loaded.format !== 'module' ||
        loaded.source == null ||
        digest(Buffer.from(loaded.source)) !== receipt.artifactSha256
      )
        throw new Error('Loaded compiled source differs from its receipt.');
      return { ...loaded, source: prepared.contents };
    },
  });
  return {
    receipts: reader.receipts,
    restore() {
      hooks.deregister();
      if (contexts.get(coverageVariable) === captureContext) contexts.delete(coverageVariable);
    },
  };
}

export async function captureCompiledBuild(builder, options, directory, coverageVariable) {
  if (coverageVariable !== undefined) assertCoverageVariable(coverageVariable);
  const contexts = globalThis[compiledContexts];
  if (!contexts?.size) return builder(options);
  if (coverageVariable === undefined && contexts.size !== 1)
    throw new Error('Generated capture requires an explicit counter namespace.');
  const context =
    coverageVariable === undefined
      ? contexts.values().next().value
      : contexts.get(coverageVariable);
  if (!context) throw new Error('Generated capture namespace is not registered.');
  mkdirSync(directory, { recursive: true });
  const output = realpathSync(directory);
  if (readdirSync(output).some((name) => /\.js(?:\.map)?$/.test(name)))
    throw new Error('Generated capture requires an empty JavaScript output directory.');
  const compilation = compiledCapturePlugin(
    context.snapshot,
    context.preparations,
    context.coverageVariable,
  );
  const result = await builder({
    ...options,
    plugins: [...(options.plugins ?? []), compilation.plugin],
  });
  if (!compilation.receipts.size)
    throw new Error('Generated capture has no owned compilation inputs.');
  const inputs = new Map();
  for (const receipt of compilation.receipts.values()) {
    inputs.set(receipt.artifact, receipt.artifactSha256);
    if (receipt.artifactMapSha256 !== null)
      inputs.set(`${receipt.artifact}.map`, receipt.artifactMapSha256);
    inputs.set(join(realpathSync(context.snapshot.root), receipt.path), receipt.sha256);
    const preparation = join(context.preparations, `${digest(receipt.path)}.json`);
    inputs.set(preparation, digest(readFileSync(preparation)));
  }
  const graph = new Map();
  for (const name of readdirSync(output).filter((name) => /\.js(?:\.map)?$/.test(name))) {
    const filename = join(output, name);
    if (realpathSync(filename) !== filename || !statSync(filename).isFile())
      throw new Error('Generated capture artifact is not a regular file.');
    graph.set(filename, digest(readFileSync(filename)));
  }
  const scripts = [...graph.keys()].filter((filename) => filename.endsWith('.js'));
  if (!scripts.length || scripts.some((filename) => !graph.has(`${filename}.map`)))
    throw new Error('Generated capture requires JavaScript and source-map artifacts.');
  for (const filename of scripts) {
    if (context.generated.has(filename))
      throw new Error('Generated capture graph already registered.');
    context.generated.set(filename, { artifacts: graph, inputs });
  }
  return result;
}

function nativeCompilerIdentity() {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve('typescript/package.json');
  const compiler = JSON.parse(readFileSync(packageFile, 'utf8'));
  const project = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  );
  const platformRequire = createRequire(packageFile);
  const platformFile = platformRequire.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const platform = JSON.parse(readFileSync(platformFile, 'utf8'));
  if (
    compiler.version !== project.devDependencies.typescript ||
    platform.version !== compiler.version
  )
    throw new Error('Native compiler version differs from the pinned toolchain.');
  const executable = realpathSync(join(dirname(platformFile), 'lib/tsc'));
  return {
    executable,
    executableSha256: digestFile(executable, Buffer.alloc(64 * 1024)),
    compilerVersion: compiler.version,
  };
}

function registerImageCollector(emit) {
  if (typeof process.execve !== 'function') return;
  if (!globalThis[imageCollectors]) {
    const collectors = new Set();
    globalThis[imageCollectors] = collectors;
    const execve = process.execve;
    process.execve = function (...args) {
      const attempt = randomUUID();
      let executable = null;
      let executableSha256 = null;
      try {
        executable = realpathSync(args[0]);
        executableSha256 = digestFile(executable, Buffer.alloc(64 * 1024));
      } catch {}
      const record = {
        state: 'execve',
        attempt,
        executable,
        executableSha256,
        argumentsSha256: digest(JSON.stringify(args[1] ?? null)),
      };
      for (const collector of collectors) collector(record);
      try {
        return execve.apply(this, args);
      } finally {
        for (const collector of collectors) collector({ state: 'execve-returned', attempt });
      }
    };
  }
  globalThis[imageCollectors].add(emit);
}

function registerWorkerCollector(emit) {
  if (!globalThis[workerCollectors]) {
    const collectors = new Set();
    globalThis[workerCollectors] = collectors;
    workerThreads.Worker = new Proxy(workerThreads.Worker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget);
        const workerThreadId = worker.threadId;
        const observers = [...collectors];
        for (const observer of observers) observer({ state: 'worker-started', workerThreadId });
        let closed = false;
        worker.on('exit', (exitCode) => {
          if (closed || worker.threadId !== -1) return;
          closed = true;
          for (const observer of observers)
            observer({ state: 'worker-closed', workerThreadId, exitCode });
        });
        const terminate = worker.terminate;
        worker.terminate = function (...values) {
          if (this === worker && !closed)
            for (const observer of observers)
              observer({ state: 'worker-terminate', workerThreadId });
          return terminate.apply(this, values);
        };
        return worker;
      },
    });
    syncBuiltinESMExports();
  }
  globalThis[workerCollectors].add(emit);
}

export function registerCounterStream(fd, coverageVariable = variable) {
  assertCoverageVariable(coverageVariable);
  const collector = coverageVariable === variable ? active : Symbol.for(coverageVariable);
  if (!Number.isSafeInteger(fd) || fd < 4)
    throw new Error('Counter stream requires a separate inherited descriptor.');
  if (globalThis[collector] || Object.hasOwn(globalThis, coverageVariable))
    throw new Error('Native coverage collector already registered or counters already exist.');
  const identity = {
    schema: 1,
    id: randomUUID(),
    pid: process.pid,
    threadId,
    provider: 'istanbul@4.1.11',
  };
  let sequence = 0;
  const emit = (record) => {
    const text = `${JSON.stringify({ ...(threadId > 0 ? { id: identity.id } : {}), ...record, sequence: ++sequence })}\n`;
    if (writeSync(fd, text, null, 'utf8') !== Buffer.byteLength(text))
      throw new Error('Incomplete native counter stream write.');
  };
  const counters = (target, path, field, key) =>
    new Proxy(target, {
      set(object, counter, value) {
        emit({
          state: 'counter',
          path,
          field,
          key: key ?? counter,
          ...(field === 'b' ? { arm: Number(counter) } : {}),
          value,
        });
        object[counter] = value;
        return true;
      },
    });
  emit({ ...identity, state: 'started' });
  globalThis[coverageVariable] = new Proxy(
    {},
    {
      set(object, path, data) {
        emit({ state: 'source', path, data });
        data.s = counters(data.s, path, 's');
        data.f = counters(data.f, path, 'f');
        for (const key of Object.keys(data.b)) data.b[key] = counters(data.b[key], path, 'b', key);
        object[path] = data;
        return true;
      },
    },
  );
  globalThis[collector] = true;
  registerImageCollector((record) => emit({ ...identity, ...record }));
  registerWorkerCollector((record) => emit({ ...identity, ...record }));
  afterProcessExit((exitCode) => emit({ ...identity, state: 'completed', exitCode }));
  return identity.id;
}

function* counterTextRecords(text) {
  let offset = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', offset)) {
    yield JSON.parse(text.slice(offset, end));
    offset = end + 1;
  }
}

async function* counterFileRecords(filename) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let observed = false;
  for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024 })) {
    pending += decoder.write(chunk);
    let offset = 0;
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', offset)) {
      observed = true;
      yield JSON.parse(pending.slice(offset, end));
      offset = end + 1;
    }
    pending = pending.slice(offset);
  }
  pending += decoder.end();
  if (!observed || pending) throw new Error('Empty or truncated native counter stream.');
}

export async function replayCounterStream(snapshot, text, hostClose) {
  if (typeof text !== 'string' || !text || !text.endsWith('\n'))
    throw new Error('Empty or truncated native counter stream.');
  return replayCounterRecords(snapshot, counterTextRecords(text), hostClose);
}

export async function replayCounterFile(snapshot, filename, hostClose) {
  return replayCounterRecords(snapshot, counterFileRecords(filename), hostClose);
}

async function replayCounterRecords(snapshot, records, hostClose) {
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const { captureCoverage } = await import('./coverage_report.mjs');
  const contexts = new Map();
  const workers = new Map();
  let rootId = null;
  for await (const record of records) {
    if (record.state === 'started') {
      if (contexts.has(record.id)) throw new Error('Repeated native counter identity.');
      if (rootId === null) rootId = record.id;
      contexts.set(record.id, {
        start: null,
        sequence: 0,
        completed: null,
        replacement: null,
        attempts: new Set(),
        maps: {},
      });
    }
    const contextId = record.id ?? rootId;
    const context = contexts.get(contextId);
    if (!context) throw new Error('Unknown native counter context.');
    let { start, sequence, completed, replacement } = context;
    const { attempts, maps } = context;
    const contextClose = contextId === rootId ? hostClose : null;
    const workerHost =
      contextId === rootId
        ? null
        : workers.get(
            `${record.pid ?? context.start?.pid}:${record.threadId ?? context.start?.threadId}`,
          );
    if (workerHost && workerHost.closed !== null)
      throw new Error('Native worker execution continued after host close.');
    try {
      if (start === null) {
        start = record;
        if (
          start.state !== 'started' ||
          start.schema !== 1 ||
          start.provider !== 'istanbul@4.1.11' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(start.id) ||
          !Number.isSafeInteger(start.pid) ||
          start.pid <= 0 ||
          !Number.isSafeInteger(start.threadId) ||
          start.threadId < 0
        )
          throw new Error('Invalid native counter stream identity.');
        if (
          contextClose &&
          (contextClose.pid !== start.pid ||
            contextClose.threadId !== start.threadId ||
            !(
              (Number.isSafeInteger(contextClose.code) && contextClose.signal === null) ||
              (contextClose.code === null && typeof contextClose.signal === 'string')
            ))
        )
          throw new Error('Native counter host close identity differs.');
        if (contextClose?.nativeAbort) {
          validateHeapDiagnostic(contextClose.nativeAbort);
          if (!nativeHeapClosure(contextClose.code, contextClose.signal))
            throw new Error('Native heap-abort host close differs.');
        }
      }
      if ((completed && !hostClose) || record.sequence !== ++sequence)
        throw new Error('Native counter stream sequence differs.');
      if (sequence === 1) continue;
      if (replacement && record.state !== 'execve-returned')
        throw new Error('Native image replacement has subsequent execution.');
      if (record.state === 'source') {
        const entry = owned.get(record.path);
        if (!entry || Object.hasOwn(maps, record.path) || record.data?.path !== record.path)
          throw new Error('Invalid or repeated native counter source.');
        if (digest(readFileSync(record.path)) !== entry.sha256)
          throw new Error(`Stale native counter source: ${entry.path}`);
        captureCoverage(snapshot, { [record.path]: record.data }, start.id);
        if (
          [
            ...Object.values(record.data.s),
            ...Object.values(record.data.f),
            ...Object.values(record.data.b).flat(),
          ].some((value) => value !== 0)
        )
          throw new Error('Native counter source starts with execution hits.');
        maps[record.path] = record.data;
      } else if (record.state === 'counter') {
        const map = maps[record.path];
        if (
          !map ||
          !['s', 'f', 'b'].includes(record.field) ||
          typeof record.key !== 'string' ||
          !Object.hasOwn(map[record.field], record.key)
        )
          throw new Error('Unknown native counter.');
        const target = record.field === 'b' ? map.b[record.key] : map[record.field];
        const key = record.field === 'b' ? record.arm : record.key;
        if (record.field === 'b' && (!Number.isSafeInteger(key) || key < 0 || key >= target.length))
          throw new Error('Unknown native branch arm.');
        if (!Number.isSafeInteger(record.value) || record.value !== target[key] + 1)
          throw new Error('Native counter increment differs.');
        target[key] = record.value;
      } else if (record.state === 'execve' || record.state === 'execve-returned') {
        for (const key of ['id', 'schema', 'provider', 'pid', 'threadId'])
          if (record[key] !== start[key])
            throw new Error('Native image replacement identity differs.');
        if (record.state === 'execve') {
          if (
            completed ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              record.attempt,
            ) ||
            attempts.has(record.attempt) ||
            !/^[0-9a-f]{64}$/.test(record.argumentsSha256)
          )
            throw new Error('Invalid native image replacement attempt.');
          attempts.add(record.attempt);
          replacement = record;
        } else {
          if (!replacement || replacement.attempt !== record.attempt)
            throw new Error('Native image replacement return differs.');
          replacement = null;
        }
      } else if (['worker-started', 'worker-closed', 'worker-terminate'].includes(record.state)) {
        for (const key of ['id', 'schema', 'provider', 'pid', 'threadId'])
          if (record[key] !== start[key])
            throw new Error('Native worker observer identity differs.');
        if (
          !Number.isSafeInteger(record.workerThreadId) ||
          record.workerThreadId <= 0 ||
          record.workerThreadId === start.threadId
        )
          throw new Error('Invalid native worker thread identity.');
        const key = `${start.pid}:${record.workerThreadId}`;
        if (record.state === 'worker-started') {
          if (workers.has(key)) throw new Error('Repeated native worker launch.');
          workers.set(key, {
            parent: start.id,
            threadId: record.workerThreadId,
            closed: null,
            terminated: false,
          });
        } else {
          const worker = workers.get(key);
          if (!worker || worker.parent !== start.id || worker.closed !== null)
            throw new Error('Native worker lifecycle differs.');
          if (record.state === 'worker-terminate') worker.terminated = true;
          else {
            if (!Number.isSafeInteger(record.exitCode))
              throw new Error('Invalid native worker exit code.');
            worker.closed = record.exitCode;
          }
        }
      } else if (record.state === 'completed') {
        if (completed) throw new Error('Repeated native counter completion.');
        for (const key of ['id', 'schema', 'provider', 'pid', 'threadId'])
          if (record[key] !== start[key])
            throw new Error('Native counter completion identity differs.');
        if (!Number.isSafeInteger(record.exitCode))
          throw new Error('Invalid native counter exit code.');
        completed = record;
      } else throw new Error('Unknown native counter stream record.');
    } finally {
      Object.assign(context, { start, sequence, completed, replacement });
    }
  }
  if (rootId === null) throw new Error('Empty or truncated native counter stream.');
  const results = [];
  const threadIds = new Set();
  for (const [id, context] of contexts) {
    const { start, completed, replacement, maps } = context;
    let contextClose = hostClose;
    let workerHost = null;
    if (id !== rootId) {
      if (
        !hostClose ||
        start.pid !== contexts.get(rootId).start.pid ||
        start.threadId <= 0 ||
        threadIds.has(start.threadId)
      )
        throw new Error('Native worker context identity differs.');
      threadIds.add(start.threadId);
      const worker = workers.get(`${start.pid}:${start.threadId}`);
      workerHost = worker;
      if (!worker || worker.closed === null) throw new Error('Native worker host close missing.');
      if (!completed && !worker.terminated) throw new Error('Native worker completion missing.');
      contextClose = {
        pid: start.pid,
        threadId: start.threadId,
        code: worker.closed,
        signal: null,
      };
    }

    let replacementCompiler = null;
    if (replacement) {
      if (!contextClose) throw new Error('Native image replacement requires host close.');
      replacementCompiler = nativeCompilerIdentity();
      if (
        replacement.executable !== replacementCompiler.executable ||
        replacement.executableSha256 !== replacementCompiler.executableSha256
      )
        throw new Error('Unqualified native image replacement.');
    }
    if (
      contextClose?.signal === null &&
      !contextClose.nativeAbort &&
      !replacement &&
      !(workerHost?.terminated && !completed) &&
      (!completed || contextClose.code !== completed.exitCode)
    )
      throw new Error('Native counter completion differs from host close.');
    captureCoverage(snapshot, maps, start.id);
    results.push({
      id: start.id,
      pid: start.pid,
      threadId: start.threadId,
      state: replacement ? 'replaced' : completed ? 'completed' : 'interrupted',
      ...(replacement
        ? {
            replacement: {
              ...replacement,
              compilerVersion: replacementCompiler.compilerVersion,
            },
          }
        : {}),
      exitCode: completed?.exitCode ?? null,
      ...(workerHost
        ? {
            hostClose: {
              parentId: workerHost.parent,
              exitCode: workerHost.closed,
              terminationRequested: workerHost.terminated,
            },
          }
        : {}),
      maps,
    });
  }
  if (workers.size !== threadIds.size) throw new Error('Native worker counter context missing.');
  const rootResult = results.find((result) => result.id === rootId);
  const threads = results.filter((result) => result.id !== rootId);
  if (!rootResult) throw new Error('Native root counter context missing.');
  const merged = threads.length ? structuredClone(rootResult.maps) : rootResult.maps;
  for (const worker of threads)
    for (const [filename, map] of Object.entries(worker.maps)) {
      if (!merged[filename]) {
        merged[filename] = structuredClone(map);
        continue;
      }
      const prior = merged[filename];
      for (const field of ['statementMap', 'fnMap', 'branchMap'])
        if (!isDeepStrictEqual(prior[field], map[field]))
          throw new Error('Native worker coverage layout differs.');
      for (const field of ['s', 'f'])
        for (const key of Object.keys(map[field])) {
          prior[field][key] += map[field][key];
          if (!Number.isSafeInteger(prior[field][key]))
            throw new Error('Native worker counter overflow.');
        }
      for (const key of Object.keys(map.b))
        for (let arm = 0; arm < map.b[key].length; arm++) {
          prior.b[key][arm] += map.b[key][arm];
          if (!Number.isSafeInteger(prior.b[key][arm]))
            throw new Error('Native worker counter overflow.');
        }
    }
  return { ...rootResult, maps: merged, ...(threads.length ? { threads } : {}) };
}

function publish(directory, name, value) {
  const filename = join(directory, name);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  try {
    linkSync(temporary, filename);
  } finally {
    unlinkSync(temporary);
  }
}

export async function prepareNativeCapture(
  snapshot,
  preparations,
  directory,
  coverageVariable = variable,
) {
  assertCoverageVariable(coverageVariable);
  const root = realpathSync(snapshot.root);
  const { createNativeInstrumenter } = await import('@vitest/coverage-istanbul/dist/provider.js');
  const instrumenter = createNativeInstrumenter({
    produceSourceMap: true,
    autoWrap: false,
    esModules: true,
    compact: false,
    coverageVariable,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: [
      ...createNativeInstrumenter().opts.parserPlugins,
      ['importAttributes', { deprecatedAssertSyntax: true }],
    ],
    generatorOpts: { importAttributesKeyword: 'with' },
    ignoreLines: true,
  });
  mkdirSync(directory);
  for (const entry of snapshot.included) {
    const key = digest(entry.path);
    const prepared = JSON.parse(readFileSync(join(preparations, `${key}.json`), 'utf8'));
    const expected = prepareSource(snapshot, join(root, entry.path), prepared.code, prepared.map);
    for (const field of ['schema', 'kind', 'provider', 'path', 'sha256'])
      if (prepared[field] !== expected[field])
        throw new Error(`Native preparation identity differs: ${entry.path}`);
    const instrumentedCode = instrumenter.instrumentSync(
      prepared.code,
      join(root, entry.path),
      prepared.map ?? undefined,
    );
    publish(directory, `${key}.json`, {
      ...prepared,
      instrumentedCode,
      instrumentedSha256: digest(instrumentedCode),
      coverageVariable,
    });
  }
}

export async function registerNativeCapture(snapshot, preparations, directory) {
  if (globalThis[active] || Object.hasOwn(globalThis, variable))
    throw new Error('Native coverage collector already registered or counters already exist.');
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const id = randomUUID();
  mkdirSync(directory, { recursive: true });
  const identity = { schema: 1, id, pid: process.pid, threadId, provider: 'istanbul@4.1.11' };
  publish(directory, `${id}.started.json`, { ...identity, state: 'started' });
  let finished = false;
  let lateReported = false;
  const rejectLate = (filename) => {
    if (!finished || lateReported) return;
    lateReported = true;
    publish(directory, `${id}.rejected.json`, {
      ...identity,
      state: 'rejected',
      path: relative(root, filename).split(sep).join('/'),
      reason: 'Owned execution continued after the exit snapshot.',
    });
  };
  const observe = (target, filename) =>
    new Proxy(target, {
      set(object, key, value) {
        rejectLate(filename);
        object[key] = value;
        return true;
      },
    });
  globalThis[variable] = new Proxy(
    {},
    {
      set(object, filename, data) {
        rejectLate(filename);
        data.s = observe(data.s, filename);
        data.f = observe(data.f, filename);
        for (const key of Object.keys(data.b)) data.b[key] = observe(data.b[key], filename);
        object[filename] = data;
        return true;
      },
    },
  );
  const loadedSources = [];
  const rejected = [];
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const address = new URL(url);
      const filename = fileURLToPath(address);
      const entry = owned.get(filename);
      if (!entry) return nextLoad(url, context);
      rejectLate(filename);
      try {
        const loaded = nextLoad(url, context);
        if (address.search || address.hash)
          throw new Error('Owned native module has query or fragment.');
        if (!['module', 'module-typescript'].includes(loaded.format))
          throw new Error(`Unsupported owned native format: ${loaded.format}`);
        if (loaded.source == null)
          throw new Error('Owned native source was not supplied by loader.');
        const bytes = Buffer.from(loaded.source);
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
          throw new Error('Loaded native source differs from inventory.');
        const key = createHash('sha256').update(entry.path).digest('hex');
        const prepared = JSON.parse(readFileSync(join(preparations, `${key}.json`), 'utf8'));
        if (
          prepared.schema !== 1 ||
          prepared.kind !== 'static-transform' ||
          prepared.provider !== identity.provider ||
          prepared.path !== entry.path ||
          prepared.sha256 !== entry.sha256
        )
          throw new Error('Native preparation identity differs from inventory.');
        prepareSource(snapshot, filename, prepared.code, prepared.map);
        if (
          prepared.coverageVariable !== variable ||
          typeof prepared.instrumentedCode !== 'string' ||
          digest(prepared.instrumentedCode) !== prepared.instrumentedSha256
        )
          throw new Error('Native instrumented preparation differs.');
        const source = prepared.instrumentedCode;
        loadedSources.push({ path: entry.path, sha256: entry.sha256 });
        return { ...loaded, format: 'module', source };
      } catch (error) {
        rejected.push({ path: entry.path, reason: error.message });
        throw error;
      }
    },
  });
  globalThis[active] = true;
  afterProcessExit((exitCode) => {
    publish(directory, `${id}.completed.json`, {
      ...identity,
      state: 'completed',
      exitCode,
      loadedSources,
      rejected,
      maps: globalThis[variable] ?? {},
    });
    finished = true;
  });
  return id;
}

export async function reconcileNativeCapture(snapshot, directory, direct = {}) {
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [join(root, entry.path), entry]));
  const starts = new Map();
  const completions = new Map();
  const issues = [];
  const files = readdirSync(directory).sort();
  if (!files.length) throw new Error('No native lifecycle records found.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const { captureCoverage } = await import('./coverage_report.mjs');
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (
      record?.schema !== 1 ||
      !uuid.test(record.id) ||
      record.provider !== 'istanbul@4.1.11' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isSafeInteger(record.threadId) ||
      record.threadId < 0 ||
      !['started', 'completed', 'rejected'].includes(record.state) ||
      file !== `${record.id}.${record.state}.json`
    )
      throw new Error(`Invalid native lifecycle record: ${file}`);
    if (record.state === 'rejected') {
      if (
        typeof record.path !== 'string' ||
        !owned.has(join(root, record.path)) ||
        typeof record.reason !== 'string'
      )
        throw new Error(`Invalid native late-execution rejection: ${file}`);
      issues.push({
        kind: 'rejected-execution',
        id: record.id,
        path: record.path,
        reason: record.reason,
      });
      continue;
    }
    const index = record.state === 'started' ? starts : completions;
    if (index.has(record.id)) throw new Error(`Duplicate native lifecycle record: ${record.id}`);
    index.set(record.id, record);
    if (record.state !== 'completed') continue;
    if (
      !Number.isSafeInteger(record.exitCode) ||
      !Array.isArray(record.loadedSources) ||
      !Array.isArray(record.rejected) ||
      !record.maps ||
      typeof record.maps !== 'object' ||
      Array.isArray(record.maps)
    )
      throw new Error(`Invalid native completion: ${file}`);
    const loaded = new Map();
    for (const source of record.loadedSources) {
      const filename = typeof source?.path === 'string' ? join(root, source.path) : '';
      const entry = owned.get(filename);
      if (
        !entry ||
        entry.path !== source.path ||
        source.sha256 !== entry.sha256 ||
        loaded.has(filename)
      )
        throw new Error(`Invalid native loaded source: ${file}`);
      if (digest(readFileSync(filename)) !== entry.sha256)
        throw new Error(`Stale native loaded source: ${source.path}`);
      loaded.set(filename, entry);
    }
    for (const rejection of record.rejected) {
      if (
        typeof rejection?.path !== 'string' ||
        typeof rejection.reason !== 'string' ||
        !snapshot.included.some((entry) => entry.path === rejection.path)
      )
        throw new Error(`Invalid native rejection: ${file}`);
      issues.push({
        kind: 'rejected-execution',
        id: record.id,
        path: rejection.path,
        reason: rejection.reason,
      });
    }
    captureCoverage(snapshot, record.maps, record.id);
    if (!isDeepStrictEqual(Object.keys(record.maps).sort(), [...loaded.keys()].sort()))
      throw new Error(`Native maps differ from loaded source ledger: ${file}`);
  }
  for (const [id, start] of starts) {
    const end = completions.get(id);
    if (!end) {
      issues.push({ kind: 'missing-completion', id });
      continue;
    }
    for (const key of ['pid', 'threadId', 'provider', 'schema'])
      if (start[key] !== end[key]) throw new Error(`Native lifecycle identity differs: ${id}`);
  }
  for (const id of completions.keys())
    if (!starts.has(id)) issues.push({ kind: 'missing-start', id });
  if (issues.length) return { status: 'Fail', processes: starts.size, issues, maps: null };
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve('@vitest/coverage-istanbul'));
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage');
  const { remapNativeCoverage } = await import('@vitest/coverage-istanbul/dist/provider.js');
  const merged = createCoverageMap({});
  for (const record of completions.values()) {
    const remapped = await remapNativeCoverage(createCoverageMap(structuredClone(record.maps)));
    const wire = JSON.parse(JSON.stringify(remapped.toJSON()));
    captureCoverage(snapshot, wire, record.id);
    const maps = Object.fromEntries(
      Object.entries(wire).map(([filename, map]) => {
        const canonical = realpathSync(filename);
        return [canonical, { ...map, path: canonical }];
      }),
    );
    for (const [filename, map] of Object.entries(maps)) {
      if (!record.loadedSources.some((source) => join(root, source.path) === filename))
        throw new Error(`Unexpected remapped native source: ${filename}`);
      const previous = direct[filename];
      if (previous)
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(previous[field], map[field]))
            throw new Error(`Native coverage layout differs from direct: ${filename}.${field}`);
      if (merged.files().includes(filename)) {
        const previous = merged.fileCoverageFor(filename).toJSON();
        for (const field of ['statementMap', 'fnMap', 'branchMap'])
          if (!isDeepStrictEqual(previous[field], map[field]))
            throw new Error(`Native coverage layouts differ: ${filename}.${field}`);
      }
    }
    if (!isDeepStrictEqual(Object.keys(maps).sort(), Object.keys(record.maps).sort()))
      throw new Error(`Native remapping lost loaded sources: ${record.id}`);
    merged.merge(maps);
  }
  return {
    status: 'Pass',
    processes: starts.size,
    issues: [],
    maps: JSON.parse(JSON.stringify(merged.toJSON())),
  };
}
