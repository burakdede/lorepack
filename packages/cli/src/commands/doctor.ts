import { count, loadConfig } from '@lorepack/core';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { DEV_PORT, isRunning, readReceipt } from '../services/dev-session.js';
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
      const port = flags.port === undefined ? undefined : Number(flags.port);
      const report = await runDoctor({
        cwd: context.options.cwd,
        ...(port === undefined ? {} : { port }),
        // A dev session of this project holding the port is not a problem to report, and
        // running doctor while your own `lore dev` is up is the common case. Studio reaches
        // the same conclusion from the other side, so the two never disagree.
        portHeldByThisProject: heldByThisProject(context.options.cwd, port),
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

/**
 * Whether the port under test is held by this project's own live dev session.
 *
 * Read from the receipt, which is evidence rather than a lock, so the pid is checked: a
 * receipt left behind by a crash names a process that is gone, and believing it would report
 * a genuinely occupied port as fine.
 */
function heldByThisProject(cwd: string, port: number | undefined): boolean {
  try {
    const config = loadConfig({ cwd });
    const receipt = readReceipt(config);
    if (receipt === null || !isRunning(receipt.pid)) return false;
    return receipt.port === (port ?? DEV_PORT);
  } catch {
    // No project, or one that will not load. Either way there is no session to credit, and
    // doctor's whole job is to keep working in exactly those directories.
    return false;
  }
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
