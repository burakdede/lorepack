import { z } from 'zod';
import { buildIdSchema, runtimeIdentitySchema } from './common.js';
import { contextProfileSchema } from './config.js';

export const executionPolicySchema = z
  .object({
    version: z.literal(1),
    canonicalizationVersion: z.int().positive(),
    retrieval: z
      .object({
        version: z.int().positive(),
        normalization: z.literal('fts5-unicode61'),
        queryVersion: z.int().positive(),
        rankingVersion: z.int().positive(),
        weightsVersion: z.int().positive(),
        weights: z.json(),
      })
      .strict(),
    packing: z
      .object({
        version: z.int().positive(),
        profile: contextProfileSchema,
        budget: z.int().positive(),
        orientationShare: z.number().min(0).max(1),
        maximumItemsPerArtifact: z.int().positive(),
        maximumAlternatives: z.int().nonnegative(),
        maximumOmissionDetails: z.int().nonnegative(),
        unit: z.literal('whole-chunk'),
      })
      .strict(),
    estimator: z
      .object({
        version: z.int().positive(),
        mode: z.literal('serialized-utf8-estimate'),
        bytesPerToken: z.number().positive(),
        wordFloor: z.literal('whitespace-words'),
        compilerVersion: z.string().min(1),
      })
      .strict(),
    visibility: z
      .object({
        version: z.int().positive(),
        default: z.enum(['current-preferred-with-historical-fallback', 'current-only']),
        includeArchived: z.boolean(),
        drafts: z.literal('eligible-labeled-downranked'),
      })
      .strict(),
    serialization: z
      .object({
        version: z.int().positive(),
        format: z.literal('bounded-supported-formats'),
        maximumBytes: z.int().positive(),
        maximumProjectNameLength: z.int().positive(),
      })
      .strict(),
  })
  .strict();

export const executionSelectionSchema = z
  .object({
    ...runtimeIdentitySchema.shape,
    buildId: buildIdSchema,
    task: z.string().min(1).max(4000),
    filters: z.array(
      z.object({ kind: z.enum(['path', 'type', 'status']), value: z.string() }).strict(),
    ),
  })
  .strict();

export const executionIdentitySchema = z
  .object({
    version: z.literal(1),
    policyId: z.string().regex(/^policy_[a-f0-9]{64}$/),
    selectionId: z.string().regex(/^selection_[a-f0-9]{64}$/),
    policy: executionPolicySchema,
    selection: executionSelectionSchema,
  })
  .strict();

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;
