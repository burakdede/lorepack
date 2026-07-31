import { z } from 'zod';
import { buildIdSchema, isoTimestampSchema } from './common.js';
import { artifactChangeSchema } from './plan.js';

/**
 * What `lore status --json` returns.
 *
 * `decidedBy` is not decoration. Freshness is only trustworthy if the user knows how it
 * was decided, and architecture section 12.3 is explicit that content hashing, never
 * mtime, is the deciding evidence. Publishing the method keeps that promise checkable.
 */
export const statusSchema = z
  .object({
    formatVersion: z.literal(1),
    projectName: z.string().min(1),
    activeBuildId: buildIdSchema.nullable(),
    activeBuildAt: isoTimestampSchema.nullable(),
    buildAgeSeconds: z.int().nonnegative().nullable(),
    sourceState: z.enum(['clean', 'dirty', 'unbuilt']),
    decidedBy: z.literal('content-hash'),
    artifacts: z
      .object({
        total: z.int().nonnegative(),
        added: z.int().nonnegative(),
        changed: z.int().nonnegative(),
        removed: z.int().nonnegative(),
      })
      .strict(),
    changes: z.array(artifactChangeSchema),
    warnings: z.int().nonnegative(),
    /** The exact command that makes the project current again, or null when it already is. */
    remediation: z.string().nullable(),
  })
  .strict();

export type Status = z.infer<typeof statusSchema>;
