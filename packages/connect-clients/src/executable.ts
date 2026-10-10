import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

/**
 * Finding a client's executable on `PATH`, and only on `PATH` (#577).
 *
 * `lorepack connect` runs inside a project, and a project can come from anyone. On Windows,
 * a bare name handed to `execFile` or to cross-spawn is looked up in the **current directory
 * first**, with every `PATHEXT` extension: a repository that ships `codex.cmd` or
 * `lorepack.bat` has it run the moment someone connects a client there (CWE-427). A relative
 * `PATH` entry, `.` or an empty one, has the same effect on every platform. So each name is
 * resolved here to an absolute file found through an absolute `PATH` entry, and that file is
 * what gets started. Nothing is ever looked up relative to the working directory.
 *
 * The second half is Windows' batch files. npm installs `codex` as `codex.cmd`, and VS Code
 * ships `code.cmd`. Since CVE-2024-27980, Node refuses to `execFile` one without a shell and
 * fails with `EINVAL`, which detection used to report as "not installed". A batch file is run
 * through `cmd.exe` with its arguments escaped, the way cross-spawn does it, which is what the
 * MCP client already uses to start the server the configuration names.
 */

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** A file `cmd.exe` has to interpret rather than one Windows can start directly. */
const BATCH = /\.(?:bat|cmd)$/i;

/** Characters `cmd.exe` treats specially, escaped with a caret (as cross-spawn does). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export interface ResolveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** A variable by name, matching case-insensitively on Windows, where `Path` is the norm. */
function variable(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(path: string, windows: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows has no execute bit; the extension is what makes a file runnable there.
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path `name` resolves to through `PATH`, or undefined when there is none.
 *
 * Only absolute `PATH` entries are searched. A name that is already a path is returned as it
 * is when it exists, since it names one file and involves no search.
 */
export function resolveExecutable(name: string, options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;

  const extensions = windows
    ? (variable(env, 'PATHEXT', true) ?? DEFAULT_PATHEXT)
        .split(';')
        .map((extension) => extension.trim())
        .filter((extension) => extension.startsWith('.'))
    : [];
  // A name that already carries a runnable extension is tried as written first.
  const candidates = windows
    ? [
        ...(extensions.some((extension) => name.toUpperCase().endsWith(extension.toUpperCase()))
          ? [name]
          : []),
        ...extensions.map((extension) => `${name}${extension}`),
      ]
    : [name];

  if (/[\\/]/.test(name)) {
    if (!paths.isAbsolute(name)) return undefined;
    return candidates.find((candidate) => isExecutableFile(candidate, windows));
  }

  const entries = (variable(env, 'PATH', windows) ?? '')
    .split(paths.delimiter)
    .map((entry) => (windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry))
    .filter((entry) => entry !== '' && paths.isAbsolute(entry));

  for (const entry of entries) {
    for (const candidate of candidates) {
      const path = paths.join(entry, candidate);
      if (isExecutableFile(path, windows)) return path;
    }
  }
  return undefined;
}

const execute = promisify(execFile);

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

/**
 * Runs a client's command, found on `PATH` only, and returns what it printed.
 *
 * The arguments are this package's own literals (`--version`, `mcp list --json`). A batch file
 * receives them through `cmd.exe`, so anything else is refused rather than escaped: there is no
 * need to pass a project path to a client here, and a quoting rule that is never exercised is
 * one that is eventually wrong.
 */
export async function runExecutable(
  name: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = options.env ?? process.env;
  const path = resolveExecutable(name, { env });
  if (path === undefined) {
    throw new Error(`\`${name}\` was not found on the PATH`);
  }

  const settings = {
    timeout: options.timeout ?? 20_000,
    windowsHide: true,
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };

  if (process.platform !== 'win32' || !BATCH.test(path)) {
    return await execute(path, [...args], settings);
  }

  for (const argument of args) {
    if (!/^[\w.-]+$/.test(argument)) {
      throw new Error(`Refusing to pass ${JSON.stringify(argument)} to ${path} through cmd.exe.`);
    }
  }
  // `cmd.exe` by absolute path: a bare `cmd.exe` would itself be looked up in the working
  // directory first, which is the very search this module exists to avoid.
  const shell =
    variable(env, 'COMSPEC', true) ??
    win32.join(variable(env, 'SYSTEMROOT', true) ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const line = [path.replace(CMD_META, '^$1'), ...args].join(' ');
  return await execute(shell, ['/d', '/s', '/c', `"${line}"`], {
    ...settings,
    windowsVerbatimArguments: true,
  });
}
