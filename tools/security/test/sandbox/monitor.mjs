// Records every network attempt in the process, wherever it comes from.
//
// Node's own diagnostics channels fire inside `net`, `dgram`, `http`, `http2` and the
// bundled fetch client, so they see a socket however the caller reached it: `tls.connect`
// and `http.get` both arrive at `net.client.socket`. DNS has no channel, so the resolver's
// entry points are wrapped. Worker threads are refused by Node itself, since the sandbox
// grants no `--allow-worker`, and reported here as well, so a refusal the build catches and
// ignores still fails the test.
//
// Child processes are the one exception the build needs (#594): every parse runs in a
// forked `parse-child.js`, so the sandbox has to grant `--allow-child-process`. This module
// therefore does the refusing that Node no longer does. The parse child's fork is let
// through only when it carries the permission model with no write, process, worker, addon or
// WASI grant; every other spawn, exec or fork is reported and refused with
// `ERR_ACCESS_DENIED`, as Node would. The sandbox loads this module into that child too
// (through `NODE_OPTIONS`), where an attempt ends the process: its stderr is not shown, so
// the attempt has to surface as the file failing to build.
import childProcess from 'node:child_process';
import dc from 'node:diagnostics_channel';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';

const IN_PARSE_CHILD = /parse-child\.js$/.test(process.argv[1] ?? '');

const report = (what) => {
  process.stderr.write(`LORE_EGRESS_ATTEMPT ${what}\n`);
  if (IN_PARSE_CHILD) process.exit(86);
};

const GRANTS = /^--allow-(fs-write|child-process|worker|addons|wasi)/;

/** The parse child, started the only way `ParserHost` starts it: sandboxed tighter than us. */
const isSandboxedParseChild = (name, args) => {
  if (name !== 'fork') return false;
  const [modulePath, , options] = args;
  const execArgv = options?.execArgv ?? [];
  return (
    /parse-child\.js$/.test(String(modulePath)) &&
    execArgv.includes('--permission') &&
    !execArgv.some((flag) => GRANTS.test(flag))
  );
};

const refuse = (target, name) => {
  const original = target[name];
  target[name] = function (...args) {
    if (isSandboxedParseChild(name, args)) return original.apply(this, args);
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
workerThreads.Worker = class extends Worker {
  constructor(...args) {
    report('worker_threads.Worker');
    super(...args);
  }
};

syncBuiltinESMExports();
