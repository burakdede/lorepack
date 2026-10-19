// Records every network attempt in the process, wherever it comes from.
//
// Node's own diagnostics channels fire inside `net`, `dgram`, `http`, `http2` and the
// bundled fetch client, so they see a socket however the caller reached it: `tls.connect`
// and `http.get` both arrive at `net.client.socket`. DNS has no channel, so the resolver's
// entry points are wrapped. Only the owned Linux parser's readonly RSS sampler worker
// is admitted. Other workers are reported and refused even if build code catches them.
//
// Child processes are the one exception the build needs (#594): every parse runs in a
// forked `parse-child.js`, so the sandbox has to grant `--allow-child-process`. This module
// therefore does the refusing that Node no longer does. The parse child's fork is let
// through only when it carries the permission model with no write, process, worker, addon or
// WASI grant. The parent may also query only that live child's RSS using the exact fixed
// OS command (#677). All other spawn, exec or fork calls are reported and refused with
// `ERR_ACCESS_DENIED`, as Node would. The sandbox loads this module into that child too
// (through `NODE_OPTIONS`), where an attempt ends the process: its stderr is not shown, so
// the attempt has to surface as the file failing to build.
import childProcess from 'node:child_process';
import dc from 'node:diagnostics_channel';
import dns from 'node:dns';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import workerThreads from 'node:worker_threads';

const PARSERS = new Map();
const SYSTEM_ROOT = process.env.SystemRoot;
const IN_PARSE_CHILD = /parse-child\.js$/.test(process.argv[1] ?? '');
const RESIDENT_READER = new URL(
  '../../../../packages/cli/dist/linux_resident_reader_worker.js',
  import.meta.url,
);

const report = (what) => {
  process.stderr.write(`LORE_EGRESS_ATTEMPT ${what}\n`);
  if (IN_PARSE_CHILD) process.exit(86);
};

const GRANTS = /^--allow-(fs-write|child-process|worker|addons|wasi)/;

/** The parse child, started the only way `ParserHost` starts it: sandboxed tighter than us. */
const isSandboxedParseChild = (name, args) => {
  if (name !== 'fork' || !workerThreads.isMainThread) return false;
  const [modulePath, , options] = args;
  const execArgv = options?.execArgv ?? [];
  return (
    /parse-child\.js$/.test(String(modulePath)) &&
    execArgv.includes('--permission') &&
    !execArgv.some((flag) => GRANTS.test(flag))
  );
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const isResidentMemoryQuery = (name, args) => {
  if (IN_PARSE_CHILD) return false;
  const [file, argv, options] = args;
  for (const [pid, child] of PARSERS) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (
      process.platform === 'darwin' &&
      name === 'spawn' &&
      file === '/bin/ps' &&
      same(argv, ['-o', 'rss=', '-p', String(pid)]) &&
      same(options, { timeout: 250, killSignal: 'SIGKILL' }) &&
      args.length === 3
    )
      return true;
    const command =
      `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); ` +
      `while($true) { $p.Refresh(); [Console]::Out.WriteLine($p.WorkingSet64); ` +
      `[Threading.Thread]::Sleep(100) }`;
    if (
      process.platform === 'win32' &&
      name === 'spawn' &&
      SYSTEM_ROOT !== undefined &&
      win32.isAbsolute(SYSTEM_ROOT) &&
      file === win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') &&
      same(argv, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]) &&
      same(options, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) &&
      args.length === 3
    )
      return true;
  }
  return false;
};

const refuse = (target, name) => {
  const original = target[name];
  target[name] = function (...args) {
    if (isSandboxedParseChild(name, args)) {
      const child = original.apply(this, args);
      if (child.pid !== undefined) {
        PARSERS.set(child.pid, child);
        child.once('close', () => PARSERS.delete(child.pid));
      }
      return child;
    }
    if (isResidentMemoryQuery(name, args)) return original.apply(this, args);
    report(`child_process.${name}`);
    throw Object.assign(new Error(`Access to child_process.${name} is refused by the sandbox.`), {
      code: 'ERR_ACCESS_DENIED',
    });
  };
};

for (const channel of [
  'net.client.socket',
  'udp.socket',
  'http.client.request.created',
  'http2.client.stream.created',
  'undici:request:create',
  'undici:client:beforeConnect',
]) {
  dc.subscribe(channel, () => report(channel));
}

const RESOLVER = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTlsa',
  'resolveTxt',
  'reverse',
];

const wrap = (target, name, label) => {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function (...args) {
    report(`${label}.${name}`);
    return original.apply(this, args);
  };
};

for (const name of RESOLVER) {
  wrap(dns, name, 'dns');
  wrap(dns.promises, name, 'dns.promises');
  wrap(dns.Resolver.prototype, name, 'dns.Resolver');
  wrap(dns.promises.Resolver.prototype, name, 'dns.promises.Resolver');
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  refuse(childProcess, name);
}

const { Worker } = workerThreads;
const keysAre = (value, keys) =>
  value !== null && typeof value === 'object' && same(Object.keys(value).sort(), [...keys].sort());
const isResidentReader = (filename, options) => {
  if (
    process.platform !== 'linux' ||
    !workerThreads.isMainThread ||
    IN_PARSE_CHILD ||
    !(filename instanceof URL) ||
    filename.href !== RESIDENT_READER.href ||
    !keysAre(options, ['execArgv', 'workerData', 'transferList']) ||
    !same(options.execArgv, []) ||
    !keysAre(options.workerData, [
      'role',
      'pid',
      'expectedBirth',
      'limitMiB',
      'generation',
      'shared',
      'port',
    ])
  )
    return false;
  const data = options.workerData;
  const child = PARSERS.get(data.pid);
  if (
    data.role !== 'lorepack-linux-resident-reader' ||
    !Number.isSafeInteger(data.pid) ||
    data.pid <= 0 ||
    typeof data.expectedBirth !== 'string' ||
    data.expectedBirth.length > 64 ||
    !/^[1-9][0-9]{0,9}:[0-9]{1,20}$/.test(data.expectedBirth) ||
    data.expectedBirth.split(':')[0] !== String(data.pid) ||
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    !Number.isInteger(data.limitMiB) ||
    data.limitMiB < 64 ||
    data.limitMiB > 32_768 ||
    !Number.isSafeInteger(data.generation) ||
    data.generation <= 0 ||
    !(data.shared instanceof SharedArrayBuffer) ||
    data.shared.byteLength !== 32 ||
    !(data.port instanceof workerThreads.MessagePort) ||
    !Array.isArray(options.transferList) ||
    options.transferList.length !== 1 ||
    options.transferList[0] !== data.port
  )
    return false;
  return realpathSync(fileURLToPath(filename)) === fileURLToPath(RESIDENT_READER);
};
workerThreads.Worker = class extends Worker {
  constructor(...args) {
    const [filename, options] = args;
    if (args.length === 2 && isResidentReader(filename, options)) {
      super(filename, { ...options, execArgv: ['--permission', '--allow-fs-read=*'] });
      return;
    }
    report('worker_threads.Worker');
    throw Object.assign(new Error('Access to worker_threads.Worker is refused by the sandbox.'), {
      code: 'ERR_ACCESS_DENIED',
    });
  }
};

if (!workerThreads.isMainThread) {
  process.kill = () => {
    report('process.kill');
    throw Object.assign(new Error('Signals are refused inside the resident reader.'), {
      code: 'ERR_ACCESS_DENIED',
    });
  };
}

syncBuiltinESMExports();
