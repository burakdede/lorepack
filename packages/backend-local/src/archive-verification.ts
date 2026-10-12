import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type ErrorCode, LoreError } from '@lorepack/core';
import type { LogicalCatalogProof } from './catalog/verify.js';

const execute = promisify(execFile);
export const ARCHIVE_VERIFY_LIMITS = {
  deadlineMs: 60_000,
  childHeapMb: 128,
  maxReplyBytes: 4 * 1024 * 1024,
} as const;

function childEntry(): string {
  const sibling = fileURLToPath(new URL('./archive-verify-child.js', import.meta.url));
  if (existsSync(sibling)) return sibling;
  const compiled = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    'dist',
    'archive-verify-child.js',
  );
  if (existsSync(compiled)) return compiled;
  throw new LoreError('LORE_E_INTERNAL', 'The archive verifier is missing from this install.', {
    remediation: 'Reinstall Lorepack or run pnpm build in a checkout.',
  });
}

interface ChildReply {
  readonly ok: boolean;
  readonly proof?: LogicalCatalogProof;
  readonly code?: ErrorCode;
  readonly message?: string;
  readonly subject?: string;
}

export async function verifyCatalogFiles(directory: string): Promise<LogicalCatalogProof> {
  let reply: ChildReply;
  try {
    const { stdout } = await execute(
      process.execPath,
      [
        `--max-old-space-size=${ARCHIVE_VERIFY_LIMITS.childHeapMb}`,
        childEntry(),
        join(directory, 'context.sqlite'),
        join(directory, 'manifest.json'),
        join(directory, 'build-id-inputs.json'),
      ],
      {
        env: {},
        timeout: ARCHIVE_VERIFY_LIMITS.deadlineMs,
        killSignal: 'SIGKILL',
        maxBuffer: ARCHIVE_VERIFY_LIMITS.maxReplyBytes,
        windowsHide: true,
      },
    );
    reply = JSON.parse(stdout) as ChildReply;
  } catch (cause) {
    if (cause instanceof LoreError) throw cause;
    throw new LoreError(
      'LORE_E_LIMIT_EXCEEDED',
      'The archive verifier exceeded its execution limits or could not finish.',
      {
        remediation:
          'Use a supported package within the verification limits. The archive was not accepted.',
        subject: 'context.sqlite',
        cause,
      },
    );
  }
  if (!reply.ok || reply.proof === undefined) {
    throw new LoreError(
      reply.code ?? 'LORE_E_OBJECT_CORRUPT',
      reply.message ?? 'Logical package verification failed.',
      {
        remediation: 'Restore or rebuild the package with a compatible Lorepack version.',
        ...(reply.subject === undefined ? {} : { subject: reply.subject }),
      },
    );
  }
  return reply.proof;
}
