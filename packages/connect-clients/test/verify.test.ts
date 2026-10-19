import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectLock } from '../../backend-local/src/lock.js';
import { LEGACY_HANDSHAKE_VERSIONS } from '../../mcp/src/protocol.js';
import { verifyStdioServer } from '../src/verify.js';
import { readExpectedSource } from './expected_build.js';

/**
 * Verifying the thing we just configured, against the real binary.
 *
 * Architecture 6.6 step 9 makes this part of connecting rather than an afterthought, because
 * every failure here is otherwise silent: a config file written correctly, naming a command
 * that is not on the path, looks exactly like success until someone asks their agent a
 * question and gets nothing back.
 *
 * A fixture server would only prove the verifier agrees with itself. These drive
 * `lorepack mcp` as a client would.
 */

const BINARY = join(import.meta.dirname, '..', '..', 'cli', 'dist', 'entry.js');
const CONFIG = 'version: 1\nname: connected\nsources:\n  - .\n';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-verify-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'lore.yaml'), CONFIG, 'utf8');
  writeFileSync(
    join(project, 'docs', 'a.md'),
    '# A\n\nRollback restores the previous build.\n',
    'utf8',
  );
});

afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows holds the build database a moment after the child exits; a leaked temp
    // directory must never fail a run that already passed its assertions.
  }
});

describe('a server that works', () => {
  it('confirms the protocol revision and the tool surface', async () => {
    const check = await verifyStdioServer({
      expected: () => readExpectedSource(project),
      executable: process.execPath,
      args: [BINARY, '--cwd', project, 'mcp', '--ensure-current'],
    });

    expect(check.ok, check.detail).toBe(true);
    expect(check.step).toBe('none');
    // The assertion that matters: `tools/list` alone would pass against a 2025-era server,
    // because it ignores an unrecognized `_meta` and answers normally. Only `server/discover`
    // settles which revision is actually being spoken.
    expect(check.protocolVersion).toBe('2026-07-28');
    expect(check.detail).toContain('tools');
  }, 120_000);
});

describe('a server that is not there', () => {
  it('says the command could not be started, and names it', async () => {
    const check = await verifyStdioServer({
      expected: () => readExpectedSource(project),
      executable: 'lorepack-command-that-does-not-exist',
      args: [],
      timeoutMs: 20_000,
    });

    expect(check.ok).toBe(false);
    expect(check.step).toBe('spawn');
    // Actionable: a generic "verification failed" sends a user looking at their client, and
    // the problem is a command in the file we wrote.
    expect(check.detail).toContain('lorepack-command-that-does-not-exist');
    expect(check.detail).toContain('on the path');
  }, 120_000);
});

describe('a command that starts and is not a server', () => {
  it('fails rather than reporting a working connection', async () => {
    // A real hazard: a path that resolves to something harmless produces a process that
    // starts fine and never speaks the protocol. Without a bound this hangs a connect.
    const check = await verifyStdioServer({
      expected: () => readExpectedSource(project),
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 3000,
    });

    expect(check.ok).toBe(false);
    expect(['spawn', 'tools']).toContain(check.step);
  }, 120_000);
});

/** Whether a process is still running. Signal 0 checks without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('a server that never answers (#578)', () => {
  it('stops shell-wrapper descendants and releases their project lock', async () => {
    const nonce = randomUUID();
    const records = join(project, 'wrapper-pids');
    mkdirSync(records);
    const lockPath = join(project, '.lore', 'lock');
    const fixture = join(project, 'wrapped-server.mjs');
    const lockModule = pathToFileURL(
      join(import.meta.dirname, '..', '..', 'backend-local', 'dist', 'lock.js'),
    ).href;
    writeFileSync(
      fixture,
      `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ProjectLock} from ${JSON.stringify(lockModule)};
const record = {nonce: ${JSON.stringify(nonce)}, pid: process.pid, ppid: process.ppid, acquired: false};
const file = join(${JSON.stringify(records)}, String(process.pid) + '.json');
writeFileSync(file, JSON.stringify(record));
const lock = new ProjectLock(${JSON.stringify(lockPath)}, {waitMs: 60000});
await lock.acquire();
record.acquired = true;
writeFileSync(file, JSON.stringify(record));
setInterval(() => {}, 1000);
`,
    );
    const windows = process.platform === 'win32';
    const wrapper = join(project, windows ? 'lorepack.cmd' : 'lorepack.sh');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      wrapper,
      windows
        ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\n${quote(process.execPath)} ${quote(fixture)}\nexit $?\n`,
      { mode: 0o755 },
    );
    const readRecords = () =>
      readdirSync(records).map((name) => {
        const record = JSON.parse(readFileSync(join(records, name), 'utf8')) as {
          nonce: string;
          pid: number;
          ppid: number;
          acquired: boolean;
        };
        expect(record.nonce).toBe(nonce);
        expect(Number.isSafeInteger(record.pid) && record.pid > 0).toBe(true);
        return record;
      });
    try {
      const check = await verifyStdioServer({
        expected: () => readExpectedSource(project),
        executable: wrapper,
        args: [],
        timeoutMs: 2000,
      });
      expect(check).toMatchObject({ ok: false, step: 'spawn' });
      expect(check.detail).toContain('timed out');
      const started = readRecords();
      expect(started.length).toBeGreaterThan(0);
      expect(started.some((record) => record.acquired)).toBe(true);
      const lock = new ProjectLock(lockPath, { waitMs: 0 });
      let available = false;
      try {
        await lock.acquire();
        available = true;
      } catch (error) {
        expect(error).toMatchObject({ code: 'LORE_E_LOCK_HELD' });
      } finally {
        lock.release();
      }
      expect({ survivingPids: started.filter((record) => alive(record.pid)), available }).toEqual({
        survivingPids: [],
        available: true,
      });
    } finally {
      const owned = readRecords();
      for (const record of owned) {
        if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
      }
      for (let attempt = 0; attempt < 100 && owned.some((record) => alive(record.pid)); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(owned.filter((record) => alive(record.pid))).toEqual([]);
      const lock = new ProjectLock(lockPath, { waitMs: 0 });
      await lock.acquire();
      lock.release();
    }
  }, 120_000);

  it('is stopped when verification gives up, along with any probe it started', async () => {
    // Each process the verifier starts records its pid and then hangs, which is what a real
    // `lorepack mcp --ensure-current` stuck behind a long build looks like from outside.
    const pids = join(project, 'pids');
    mkdirSync(pids);
    const hang = `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(
      pids,
    )}, String(process.pid)), ''); setInterval(() => {}, 1000);`;

    const check = await verifyStdioServer({
      expected: () => readExpectedSource(project),
      executable: process.execPath,
      args: ['-e', hang],
      timeoutMs: 2000,
    });

    expect(check.ok).toBe(false);
    expect(check.step).toBe('spawn');
    expect(check.detail).toContain('timed out');

    const started = readdirSync(pids).map(Number);
    expect(started.length).toBeGreaterThan(0);
    expect(started.filter(alive)).toEqual([]);
  }, 120_000);
});

describe('fresh legacy fallback ownership (#578)', () => {
  it.each(['method-not-found', 'exit-on-probe'] as const)(
    'reaps the disposable probe before the fresh legacy session needs its project lock (%s)',
    async (mode) => {
      const { execFileSync } = await import('node:child_process');
      execFileSync(process.execPath, [BINARY, '--cwd', project, 'build'], { timeout: 120_000 });
      const fixture = join(project, 'legacy-server.mjs');
      const records = join(project, 'legacy-pids');
      mkdirSync(records);
      const nonce = randomUUID();
      const moduleUrl = (relative: string) =>
        pathToFileURL(join(import.meta.dirname, relative)).href;
      writeFileSync(
        fixture,
        `
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {ProjectLock} from ${JSON.stringify(moduleUrl('../../backend-local/dist/lock.js'))};
import {createLocalRuntimeBackend} from ${JSON.stringify(moduleUrl('../../backend-local/dist/index.js'))};
import {createRuntime} from ${JSON.stringify(moduleUrl('../../runtime/dist/index.js'))};
const root = ${JSON.stringify(project)};
const lock = new ProjectLock(join(root,'.lore','lock'), {waitMs:0});
const backend = createLocalRuntimeBackend({projectRoot:root});
const runtime = createRuntime(backend);
let role;
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
setInterval(()=>{},1000);
createInterface({input:process.stdin}).on('line', async line=>{
 const message=JSON.parse(line);
 if(message.id===undefined)return;
 try {
  if(role===undefined){
   role=message.method==='server/discover'?'probe':'session';
   await lock.acquire();
   writeFileSync(join(${JSON.stringify(records)},String(process.pid)+'.json'),JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid,role}));
   if(role==='session')lock.release();
   if(role==='probe' && ${JSON.stringify(mode)}==='exit-on-probe')process.exit(0);
  }
  if(message.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}})+'\\n');
  else if(message.method==='initialize')send(message.id,{protocolVersion:${JSON.stringify(LEGACY_HANDSHAKE_VERSIONS[0])},capabilities:{tools:{}},serverInfo:{name:'legacy-fixture',version:'1.0.0'}});
  else if(message.method==='tools/list')send(message.id,{tools:['lore_build_info','lore_read_source'].map(name=>({name,inputSchema:{type:'object'}}))});
  else if(message.method==='tools/call'){
   const value=message.params.name==='lore_build_info'?await runtime.describeBuild({}):await runtime.readSource(message.params.arguments);
   send(message.id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  }
 }catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:error.message}})+'\\n');}
});
`,
      );
      const owned = () =>
        readdirSync(records)
          .map(
            (name) =>
              JSON.parse(readFileSync(join(records, name), 'utf8')) as {
                nonce: string;
                pid: number;
                role: string;
              },
          )
          .filter((record) => record.nonce === nonce);
      try {
        const check = await verifyStdioServer({
          executable: process.execPath,
          args: [fixture],
          expected: () => readExpectedSource(project),
          timeoutMs: 10_000,
        });
        expect(check.ok, check.detail).toBe(true);
        expect(check.protocolVersion).toBeUndefined();
        expect(
          owned()
            .map((record) => record.role)
            .sort(),
        ).toEqual(['probe', 'session']);
        expect(owned().filter((record) => alive(record.pid))).toEqual([]);
      } finally {
        for (const record of owned()) if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
        for (
          let attempt = 0;
          attempt < 100 && owned().some((record) => alive(record.pid));
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(owned().filter((record) => alive(record.pid))).toEqual([]);
      }
    },
    120_000,
  );
});

it('verifies fresh modern probe/session trees through an npm-style wrapper with literal path arguments', async () => {
  const target = join(project, 'project with spaces & symbols');
  mkdirSync(join(target, 'docs'), { recursive: true });
  writeFileSync(join(target, 'lore.yaml'), 'version: 1\nname: wrapped\nsources: [docs]\n');
  writeFileSync(join(target, 'docs', 'a.md'), '# Evidence\n\nUse the reviewed checkpoint.\n');
  const nonce = randomUUID();
  const records = join(project, 'modern-pids');
  mkdirSync(records);
  const preload = join(target, 'record-process.mjs');
  writeFileSync(
    preload,
    `
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(join(${JSON.stringify(records)},String(process.pid)+'.json'), JSON.stringify({
 nonce:${JSON.stringify(nonce)},pid:process.pid,ppid:process.ppid,args:process.argv.slice(2),
 privateTokenPresent:process.env.LOREPACK_VERIFY_TOKEN!==undefined
}));
`,
  );
  const windows = process.platform === 'win32';
  const wrapperDirectory = join(project, 'node_modules', '.bin');
  mkdirSync(wrapperDirectory, { recursive: true });
  const wrapper = join(wrapperDirectory, windows ? 'lorepack.cmd' : 'lorepack.sh');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const importer = pathToFileURL(preload).href;
  writeFileSync(
    wrapper,
    windows
      ? `@echo off\r\n"${process.execPath}" --import "${importer.replaceAll('%', '%%')}" "${BINARY}" %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\n${quote(process.execPath)} --import ${quote(importer)} ${quote(BINARY)} "$@"\nexit $?\n`,
    { mode: 0o755 },
  );
  const args = ['--cwd', target, 'mcp', '--ensure-current'];
  const owned = () =>
    readdirSync(records)
      .map(
        (name) =>
          JSON.parse(readFileSync(join(records, name), 'utf8')) as {
            nonce: string;
            pid: number;
            ppid: number;
            args: string[];
            privateTokenPresent: boolean;
          },
      )
      .filter((record) => record.nonce === nonce);
  try {
    const check = await verifyStdioServer({
      executable: wrapper,
      args,
      expected: () => readExpectedSource(target),
    });
    expect(check.ok, check.detail).toBe(true);
    expect(check.protocolVersion).toBe('2026-07-28');
    expect(owned()).toHaveLength(2);
    for (const record of owned()) {
      expect(record.args).toEqual(args);
      expect(record.privateTokenPresent).toBe(false);
      expect(alive(record.pid)).toBe(false);
      expect(alive(record.ppid)).toBe(false);
    }
    const lock = new ProjectLock(join(target, '.lore', 'lock'), { waitMs: 0 });
    await lock.acquire();
    lock.release();
  } finally {
    for (const record of owned()) if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 100 && owned().some((record) => alive(record.pid)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(owned().filter((record) => alive(record.pid))).toEqual([]);
  }
}, 120_000);
