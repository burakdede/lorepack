import { z } from 'zod';
import { buildIdSchema, canonicalPathSchema, capabilitySchema, sha256Schema } from './common.js';

/**
 * What `lore diff --json` returns.
 *
 * The diff is computed from canonical build records alone, never by re-reading sources.
 * That is what makes comparing any two builds instant, and what makes a comparison still
 * possible after the sources are gone.
 */

export const diffArtifactChangeSchema = z
  .object({
    path: canonicalPathSchema,
    change: z.enum(['added', 'changed', 'removed']),
    /**
     * Set when this artifact's content hash matches one on the other side at a different
     * path. Lorepack reports the pair and lets the reader conclude it was a move; it does
     * not claim to have detected an intent.
     */
    sameContentAs: canonicalPathSchema.optional(),
  })
  .strict();

export const diffRuleChangeSchema = z
  .object({
    path: canonicalPathSchema,
    field: z.enum(['status', 'authority', 'supersedes']),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .strict();

export const diffTableChangeSchema = z
  .object({
    tableId: z.string().min(1),
    name: z.string().min(1),
    rowsBefore: z.int().nonnegative().nullable(),
    rowsAfter: z.int().nonnegative().nullable(),
    columnsAdded: z.array(z.string()),
    columnsRemoved: z.array(z.string()),
  })
  .strict();

export const buildDiffSchema = z
  .object({
    formatVersion: z.literal(1),
    from: buildIdSchema,
    to: buildIdSchema,
    identical: z.boolean(),
    /**
     * Present when the two builds were produced by different formats or schemas. A diff
     * across a schema change can be misleading, so it is stated rather than smoothed over.
     */
    incompatibilities: z.array(
      z.object({ field: z.string(), from: z.string(), to: z.string() }).strict(),
    ),
    artifacts: z
      .object({
        added: z.int().nonnegative(),
        changed: z.int().nonnegative(),
        removed: z.int().nonnegative(),
        changes: z.array(diffArtifactChangeSchema),
      })
      .strict(),
    rules: z.array(diffRuleChangeSchema),
    chunks: z
      .object({
        added: z.int().nonnegative(),
        changed: z.int().nonnegative(),
        removed: z.int().nonnegative(),
      })
      .strict(),
    tables: z.array(diffTableChangeSchema),
    capabilities: z.array(
      z
        .object({ capability: capabilitySchema, change: z.enum(['same', 'added', 'removed']) })
        .strict(),
    ),
    canonicalRoots: z.array(
      z
        .object({ root: z.string(), from: sha256Schema, to: sha256Schema, changed: z.boolean() })
        .strict(),
    ),
  })
  .strict();

export type BuildDiff = z.infer<typeof buildDiffSchema>;
export type DiffArtifactChange = z.infer<typeof diffArtifactChangeSchema>;
export type DiffRuleChange = z.infer<typeof diffRuleChangeSchema>;
