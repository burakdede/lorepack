import { type TempProject, withTempProject } from './temp-project.js';

export interface DeterminismReport {
  readonly deterministic: boolean;
  readonly results: readonly string[];
  readonly conditions: readonly string[];
  readonly message?: string;
}

export interface DeterminismOptions {
  readonly files: Readonly<Record<string, string>>;
  /** Produces the value under test, typically a build ID or a canonical hash root. */
  readonly produce: (
    project: TempProject,
    enumerationOrder: readonly string[],
  ) => Promise<string> | string;
}

/**
 * Runs the four conditions from architecture section 20.3 that a single machine can
 * check: twice in one place, from a second absolute path, and with the enumeration order
 * shuffled. The Windows and POSIX condition is supplied by the CI matrix.
 */
export async function checkDeterminism(options: DeterminismOptions): Promise<DeterminismReport> {
  const names = Object.keys(options.files);
  const conditions = [
    'first run',
    'second run, same absolute path',
    'different absolute path',
    'shuffled enumeration order',
  ];

  const results: string[] = [];

  await withTempProject({ files: options.files }, async (project) => {
    results.push(String(await options.produce(project, names)));
    results.push(String(await options.produce(project, names)));
  });

  await withTempProject({ files: options.files, prefix: 'lorepack-alt-' }, async (project) => {
    results.push(String(await options.produce(project, names)));
    results.push(String(await options.produce(project, [...names].reverse())));
  });

  const first = results[0];
  const deterministic = results.every((r) => r === first);
  return {
    deterministic,
    results,
    conditions,
    ...(deterministic
      ? {}
      : {
          message: `Non-deterministic output.\n${conditions
            .map((c, i) => `  ${c}: ${results[i]}`)
            .join('\n')}`,
        }),
  };
}
