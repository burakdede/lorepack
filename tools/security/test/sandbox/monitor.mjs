// Records every network attempt in the process, wherever it comes from.
//
// Node's own diagnostics channels fire inside `net`, `dgram`, `http`, `http2` and the
// bundled fetch client, so they see a socket however the caller reached it: `tls.connect`
// and `http.get` both arrive at `net.client.socket`. DNS has no channel, so the resolver's
// entry points are wrapped. Child processes and worker threads are refused by Node itself,
// since the sandbox grants neither `--allow-child-process` nor `--allow-worker`; they are
// reported here as well, so a refusal the build catches and ignores still fails the test.
import childProcess from 'node:child_process';
import dc from 'node:diagnostics_channel';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';

const report = (what) => {
  process.stderr.write(`LORE_EGRESS_ATTEMPT ${what}\n`);
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
  wrap(childProcess, name, 'child_process');
}

const { Worker } = workerThreads;
workerThreads.Worker = class extends Worker {
  constructor(...args) {
    report('worker_threads.Worker');
    super(...args);
  }
};

syncBuiltinESMExports();
