import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';

const original = childProcess.fork;
childProcess.fork = function (...args) {
  const child = original.apply(this, args);
  const options = { encoding: 'utf8', maxBuffer: 256, timeout: 250, killSignal: 'SIGKILL' };
  const file = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const command = (pid) =>
    `$ErrorActionPreference='Stop'; $p=[System.Diagnostics.Process]::GetProcessById(${pid}); ` +
    `while($true) { $p.Refresh(); [Console]::Out.WriteLine($p.WorkingSet64); ` +
    `[Threading.Thread]::Sleep(100) }`;
  const attempt = (run) => {
    try {
      const unexpected = run();
      unexpected.kill('SIGKILL');
      throw new Error('The sandbox admitted an unauthorized observer.');
    } catch (error) {
      if (error.code !== 'ERR_ACCESS_DENIED') throw error;
    }
  };
  attempt(() =>
    childProcess.execFile('/bin/ps', ['-o', 'rss=', '-p', String(process.pid)], options, () => {}),
  );
  attempt(() =>
    childProcess.execFile(
      '/bin/ps',
      ['-o', 'rss=', '-p', String(child.pid)],
      { ...options, shell: true },
      () => {},
    ),
  );
  attempt(() => childProcess.execFile('/bin/ps', ['-A'], options, () => {}));
  const macOptions = { timeout: 250, killSignal: 'SIGKILL' };
  const macArgs = ['-o', 'rss=', '-p', String(child.pid)];
  attempt(() => childProcess.execFile('/bin/ps', macArgs, options, () => {}));
  attempt(() =>
    childProcess.spawn('/bin/ps', ['-o', 'rss=', '-p', String(process.pid)], macOptions),
  );
  attempt(() => childProcess.spawn('/bin/ps', ['-A'], macOptions));
  attempt(() => childProcess.spawn('/bin/ps', macArgs, { ...macOptions, shell: true }));
  attempt(() => childProcess.spawn('/bin/ps', macArgs, { ...macOptions, timeout: 251 }));
  attempt(() => childProcess.spawn('/bin/ps', macArgs, { ...macOptions, killSignal: 'SIGTERM' }));
  const spawnOptions = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
  attempt(() => childProcess.spawn(file, [...flags, command(process.pid)], spawnOptions));
  attempt(() =>
    childProcess.spawn(
      file,
      [...flags, `${command(child.pid)}; Write-Output changed`],
      spawnOptions,
    ),
  );
  return child;
};
syncBuiltinESMExports();
