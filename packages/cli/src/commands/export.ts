import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import {
  type ContextProfile,
  contextProfileSchema,
  createContextReceipt,
  LoreError,
  loadProjectConfig,
  sanitizeForTerminal,
  writeFileAtomic,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import type { CommandDefinition, CommandResult } from '../framework/program.js';
import { moreCommandFor, renderBundleMarkdown } from '../services/export.js';
import { readFreshness } from '../services/status.js';

/**
 * `lorepack export`: one file a person can paste into any chat product.
 *
 * Architecture 14.6 calls this the universal compatibility bridge, and that is the honest
 * framing: MCP is better, and most chat products cannot speak it. The output is bounded,
 * cited, and explicit about what did not fit, because a context bundle that quietly
 * dropped half the corpus is indistinguishable from one that had nothing else to give.
 *
 * Defaults to the `chat` profile and its 24,000 token budget, which is the profile sized
 * for exactly this: one paste, one bounded file.
 */

const EXPORT_PROFILE: ContextProfile = 'chat';

export function exportCommand(): CommandDefinition {
  return {
    name: 'export',
    description: 'Write a bounded, cited context bundle for a task. Markdown or JSON.',
    flags: [
      { flags: '--build <id>', description: 'read this full retained build ID instead of active' },
      { flags: '--task <text>', description: 'what the context is for' },
      { flags: '--profile <name>', description: 'agent, coding, chat or deep (default chat)' },
      { flags: '--budget <tokens>', description: 'estimated token budget, overriding the profile' },
      { flags: '--format <format>', description: 'markdown or json (default markdown)' },
      { flags: '--output <file>', description: 'write to a file instead of stdout' },
      { flags: '--receipt <file>', description: 'write a detached receipt for the exported bytes' },
      {
        flags: '--capture-request',
        description: 'include normalized task and filters in the receipt',
      },
      { flags: '--force', description: 'overwrite an existing output file' },
      {
        flags: '--include-archived',
        description: 'explicitly include labeled archived and superseded evidence',
      },
      {
        flags: '--allow-unsupported-budget',
        description: 'permit a budget outside the supported 4,000 to 40,000 range',
      },
    ],
    handler: async (_args, flags, context): Promise<CommandResult> => {
      const config = loadProjectConfig({ cwd: context.options.cwd });
      const task = typeof flags.task === 'string' ? flags.task.trim() : '';
      if (task === '') {
        throw new LoreError('LORE_E_INVALID_ARGUMENT', 'An export needs a task to select for.', {
          remediation: 'Pass --task "what you are trying to do".',
        });
      }

      const format = parseFormat(flags.format);
      const profile = parseProfile(flags.profile);
      const output = typeof flags.output === 'string' ? absolute(flags.output, config) : null;
      const receipt = typeof flags.receipt === 'string' ? absolute(flags.receipt, config) : null;
      if (flags.receipt === '' || (flags.captureRequest === true && receipt === null)) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          '--capture-request requires --receipt <file>.',
          {
            remediation: 'Choose a receipt filename, or omit request capture.',
          },
        );
      }
      if (receipt !== null && receipt === output) {
        throw new LoreError(
          'LORE_E_INVALID_ARGUMENT',
          'Output and receipt must use distinct paths.',
          {
            remediation: 'Choose a separate receipt filename.',
          },
        );
      }
      if (receipt !== null && existsSync(receipt) && flags.force !== true) {
        throw new LoreError('LORE_E_INVALID_ARGUMENT', `${flags.receipt} already exists.`, {
          remediation: 'Pass --force to overwrite it, or choose another --receipt path.',
          subject: String(flags.receipt),
        });
      }
      if (output !== null && existsSync(output) && flags.force !== true) {
        throw new LoreError('LORE_E_INVALID_ARGUMENT', `${flags.output} already exists.`, {
          remediation: 'Pass --force to overwrite it, or choose another --output path.',
          subject: String(flags.output),
        });
      }

      const freshness = await readFreshness({ config });
      const backend = createLocalRuntimeBackend({
        projectRoot: config.projectRoot,
        freshness: async () => freshness.sourceState,
      });

      try {
        if (flags.build === undefined && (await backend.provider.current()) === null) {
          throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no build to export.', {
            remediation: 'Run `lorepack build` first.',
          });
        }

        const bundle = await createRuntime(backend).contextForTask({
          ...(typeof flags.build === 'string' ? { buildId: flags.build } : {}),
          task,
          profile,
          includeArchived: flags.includeArchived === true,
          allowUnsupportedBudget: flags.allowUnsupportedBudget === true,
          ...(flags.budget === undefined ? {} : { budget: parseBudget(flags.budget) }),
          ...(receipt === null
            ? {}
            : { receipt: { captureRequest: flags.captureRequest === true } }),
        });

        const rendered =
          format === 'json'
            ? `${JSON.stringify(bundle, null, 2)}\n`
            : renderBundleMarkdown(bundle, {
                projectName: config.config.name,
                sourceState: bundle.sourceState,
                moreCommand: moreCommandFor(task),
              });

        const emitted =
          output !== null
            ? rendered
            : context.options.json
              ? `${JSON.stringify(bundle, null, 2)}\n`
              : `${context.streams.isTty ? sanitizeForTerminal(rendered.trimEnd()) : rendered.trimEnd()}\n`;
        const detached =
          receipt === null
            ? null
            : await createContextReceipt({
                bundle,
                payload: emitted,
                format: output === null && context.options.json ? 'json' : format,
                captureRequest: flags.captureRequest === true,
              });

        if (output === null) {
          if (receipt !== null && detached !== null)
            writeFileAtomic(receipt, JSON.stringify(detached));
          // stdout carries the export and nothing else, so `lorepack export ... > file.md` and
          // `--output file.md` produce the same bytes.
          return { human: rendered.trimEnd(), json: bundle, verbatim: true };
        }

        // Atomic, because a half-written context file that looks complete is worse than no
        // file: a person would paste it without noticing.
        writeFileAtomic(output, rendered);
        if (receipt !== null && detached !== null)
          writeFileAtomic(receipt, JSON.stringify(detached));
        context.warn(
          `Wrote ${output}\n  ${bundle.estimatedTokens} estimated tokens of ${bundle.budget}, ${bundle.citations.length} citations, ${bundle.omissionSummary.total} omitted.\n`,
        );
        return { human: '', json: bundle };
      } finally {
        backend.close();
      }
    },
  };
}

function parseFormat(raw: unknown): 'markdown' | 'json' {
  if (raw === undefined) return 'markdown';
  if (raw === 'markdown' || raw === 'json') return raw;
  throw new LoreError('LORE_E_INVALID_ARGUMENT', `--format must be markdown or json, got ${raw}.`, {
    remediation: 'Pass --format markdown for a file to paste, or --format json for a program.',
  });
}

function parseProfile(raw: unknown): ContextProfile {
  if (raw === undefined) return EXPORT_PROFILE;
  const parsed = contextProfileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new LoreError(
    'LORE_E_INVALID_ARGUMENT',
    `--profile must be one of agent, coding, chat, deep, got ${raw}.`,
    {
      remediation: 'Omit it for `chat`, which is sized for one paste into a chat product.',
    },
  );
}

function parseBudget(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new LoreError('LORE_E_INVALID_ARGUMENT', `--budget must be a whole number, got ${raw}.`, {
      remediation: 'Pass an estimated token budget, for example --budget 24000.',
    });
  }
  return value;
}

function absolute(path: string, config: ReturnType<typeof loadProjectConfig>): string {
  return isAbsolute(path) ? path : resolve(config.projectRoot, path);
}
