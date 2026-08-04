import { z } from 'zod';
import {
  buildIdSchema,
  canonicalPathSchema,
  capabilitySchema,
  embeddingProfileSchema,
  isoTimestampSchema,
  sha256Schema,
} from './common.js';

/** Versions that can affect deterministic output. `lore build --frozen` fails on drift. */
export const lockfileSchema = z
  .object({
    formatVersion: z.literal(1),
    compiler: z.string().min(1),
    schema: z.int().positive(),
    parsers: z.record(z.string().min(1), z.string().min(1)),
    semantic: embeddingProfileSchema.nullable(),
  })
  .strict();

export const buildWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: canonicalPathSchema.optional(),
    class: z.enum(['unsupported-file', 'parser', 'envelope', 'rule', 'security']),
  })
  .strict();

/**
 * What an ignore rule removed, grouped by the rule that removed it.
 *
 * Discovery used to drop an ignored path with a bare `return`, so a file removed by a rule
 * was recorded nowhere: not in the build, not in `lore inspect`, not over the API, and not
 * in the Studio view whose whole purpose is naming what is missing and why (#202). A rule
 * written too broadly could take a whole directory out of every answer, invisibly.
 *
 * Grouped by rule rather than listed per file, because the number of files a rule removes
 * is bounded by the corpus and not by the build: `node_modules/` is one decision, whether it
 * takes 12 files or 200,000. `sample` is capped and sorted so two builds of identical inputs
 * record identical bytes.
 */
export const buildExclusionSchema = z
  .object({
    /** The rule as written, so a reader can find it in the file it came from. */
    pattern: z.string().min(1),
    /** Which layer wrote it: the built-in defaults, or the project's own `.loreignore`. */
    source: z.string().min(1),
    /** Paths this rule removed. A pruned directory counts once, not once per file inside. */
    count: z.int().positive(),
    sample: z.array(z.string().min(1)),
  })
  .strict();

export const buildManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    buildId: buildIdSchema,
    projectName: z.string().min(1),
    compilerVersion: z.string().min(1),
    schemaVersion: z.int().positive(),
    configurationHash: sha256Schema,
    sourceFingerprint: sha256Schema,
    canonicalRoots: z
      .object({
        artifacts: sha256Schema,
        nodes: sha256Schema,
        chunks: sha256Schema,
        tables: sha256Schema,
        objects: sha256Schema,
      })
      .strict(),
    capabilities: z.array(capabilitySchema).min(1),
    embeddingProfile: embeddingProfileSchema.optional(),
    counts: z
      .object({
        artifacts: z.int().nonnegative(),
        nodes: z.int().nonnegative(),
        chunks: z.int().nonnegative(),
        tables: z.int().nonnegative(),
        tableRows: z.int().nonnegative(),
      })
      .strict(),
    warnings: z.array(buildWarningSchema),
    /**
     * Optional so a build written before #202 still parses. Absent means "this build does not
     * know", which is different from an empty array meaning "nothing was excluded", and the
     * interfaces say so rather than rendering the two the same way.
     */
    exclusions: z.array(buildExclusionSchema).optional(),
  })
  .strict()
  .refine(
    (manifest) =>
      !manifest.capabilities.includes('semantic-search') || manifest.embeddingProfile !== undefined,
    { message: 'A build advertising semantic-search must record its complete embedding profile' },
  );

/**
 * Wall-clock and machine facts, kept outside the canonical build and outside .lorepack so
 * two machines can agree on identity while disagreeing about how long the build took.
 */
export const buildReceiptSchema = z
  .object({
    buildId: buildIdSchema,
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
    durationMs: z.int().nonnegative(),
    cache: z
      .object({
        reusedArtifacts: z.int().nonnegative(),
        rebuiltArtifacts: z.int().nonnegative(),
      })
      .strict(),
    platform: z.string().min(1),
    nodeVersion: z.string().min(1),
  })
  .strict();

export const buildStateSchema = z.enum([
  'planned',
  'building',
  'validating',
  'verified',
  'failed',
  'active',
  'packed',
  'projected',
  'remotely_verified',
  'remotely_active',
]);

export type Lockfile = z.infer<typeof lockfileSchema>;
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export type BuildReceipt = z.infer<typeof buildReceiptSchema>;
export type BuildWarning = z.infer<typeof buildWarningSchema>;
export type BuildExclusion = z.infer<typeof buildExclusionSchema>;
export type BuildState = z.infer<typeof buildStateSchema>;
