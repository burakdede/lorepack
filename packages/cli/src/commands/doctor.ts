import { count } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { type CheckResult, type DoctorReport, runDoctor } from '../services/doctor.js';

/**
 * `lore doctor`: when something is wrong, one command names it and says what to do.
 *
 * Architecture 6.5 and 6.9. Everything here is read-only, so it is safe to run at any time,
 * including against a project that is mid-build, and it works in a directory that is not a
 * project at all: reporting the environment is useful before there is anything to configure.
 *
 * The checks themselves live in `services/doctor.ts` because Phase 4's Studio Diagnostics
 * route (#69) renders the same results over HTTP, and two implementations of "what is wrong
 * with this environment" would be two answers to one question.
 */

export function doctorCommand(): CommandDefinition {
  return {
    name: 'doctor',
    description: 'Check this environment and project, and say how to fix what is wrong.',
    flags: [
      {
        flags: '--ci',
        description: 'exit non-zero when any check fails, for use in a pipeline',
      },
      { flags: '--port <number>', description: 'the dev port to test (default 43110)' },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const report = await runDoctor({
        cwd: context.options.cwd,
        ...(flags.port === undefined ? {} : { port: Number(flags.port) }),
      });

      return {
        human: render(report),
        json: report,
        // Without `--ci` a failed check is information, not a failed command: someone
        // running doctor to read it has not done anything wrong. With it, the exit code is
        // the whole point (architecture 18.8).
        ...(flags.ci === true && report.status === 'fail' ? { exitCode: 1 } : {}),
      };
    },
  };
}

const MARK: Record<CheckResult['status'], string> = { pass: 'ok', warn: 'warn', fail: 'FAIL' };

function render(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.project === null
      ? 'No project here. Checking the environment only.'
      : `Project ${report.project}`,
  );
  lines.push('');

  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status].padEnd(5)} ${check.title.padEnd(22)} ${check.detail}`);
    if (check.remediation !== undefined) {
      // Indented under the check it belongs to, and never truncated: the remediation is the
      // reason the command exists.
      for (const line of check.remediation.split('\n')) lines.push(`        ${line}`);
    }
  }

  lines.push('');
  if (report.counts.fail > 0) {
    lines.push(`${count(report.counts.fail, 'check')} failed. Fix the ones marked FAIL above.`);
  } else if (report.counts.warn > 0) {
    lines.push(
      `Everything essential works. ${count(report.counts.warn, 'check')} worth knowing about.`,
    );
  } else {
    lines.push('Everything checks out.');
  }
  return lines.join('\n');
}
