import { z } from 'zod';
import {
  buildIdSchema,
  canonicalPathSchema,
  capabilitySchema,
  isoTimestampSchema,
  sha256Schema,
} from './common.js';

const changeKindSchema = z.enum(['added', 'changed', 'removed', 'reused']);

export const artifactChangeSchema = z
  .object({ path: canonicalPathSchema, change: changeKindSchema })
  .strict();

export const ruleChangeSchema = z
  .object({
    path: canonicalPathSchema,
    field: z.enum(['status', 'authority', 'supersedes']),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .strict();

export const tableChangeSchema = z
  .object({
    tableId: z.string().min(1),
    name: z.string().min(1),
    rowsBefore: z.int().nonnegative().nullable(),
    rowsAfter: z.int().nonnegative().nullable(),
    columnsAdded: z.array(z.string()),
    columnsRemoved: z.array(z.string()),
  })
  .strict();

const transferStateValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const deployTransferSchema = z
  .object({
    archive: z
      .object({
        key: z.string().min(1),
        sha256: sha256Schema.optional(),
        sizeBytes: z.int().positive().optional(),
      })
      .strict()
      .optional(),
    objects: z
      .object({
        referenced: z.int().nonnegative(),
        uploaded: z.int().nonnegative(),
        skipped: z.int().nonnegative(),
        verified: z.int().nonnegative(),
      })
      .strict()
      .optional(),
    state: z.record(z.string(), transferStateValueSchema).optional(),
  })
  .strict();

/** `lore plan` is side-effect free. This is what it returns with --json. */
export const planSchema = z
  .object({
    formatVersion: z.literal(1),
    projectName: z.string().min(1),
    activeBuildId: buildIdSchema.nullable(),
    generatedAt: isoTimestampSchema,
    sourceState: z.enum(['clean', 'dirty', 'unknown']),
    artifacts: z
      .object({
        added: z.int().nonnegative(),
        changed: z.int().nonnegative(),
        removed: z.int().nonnegative(),
        reused: z.int().nonnegative(),
        changes: z.array(artifactChangeSchema),
      })
      .strict(),
    rules: z.array(ruleChangeSchema),
    tables: z.array(tableChangeSchema),
    lock: z
      .object({
        changed: z.boolean(),
        changes: z.array(
          z
            .object({ key: z.string(), from: z.string().nullable(), to: z.string().nullable() })
            .strict(),
        ),
      })
      .strict(),
    capabilities: z
      .object({
        current: z.array(capabilitySchema),
        next: z.array(capabilitySchema),
      })
      .strict(),
    expectedWork: z
      .object({
        parseArtifacts: z.int().nonnegative(),
        reuseArtifacts: z.int().nonnegative(),
        rebuildChunks: z.int().nonnegative(),
      })
      .strict(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();

export const deploymentReceiptSchema = z
  .object({
    formatVersion: z.literal(1),
    receiptId: z.string().min(1),
    target: z.string().min(1),
    project: z.string().min(1),
    buildId: buildIdSchema,
    previousBuildId: buildIdSchema.nullable(),
    state: z.enum(['planned', 'projecting', 'projected', 'verified', 'active', 'failed']),
    deployedAt: isoTimestampSchema,
    endpoint: z.url().nullable(),
    capabilityLossAccepted: z.array(capabilitySchema),
    completedSteps: z.array(z.string()),
    transfer: deployTransferSchema.optional(),
    verifiedCapabilities: z.array(capabilitySchema).optional(),
    verification: z
      .object({
        search: z.enum(['passed', 'failed', 'skipped']),
        sourceRead: z.enum(['passed', 'failed', 'skipped']),
        tableQuery: z.enum(['passed', 'failed', 'skipped']),
      })
      .strict(),
  })
  .strict();

export const remoteRetentionPlanSchema = z
  .object({
    activeBuildId: buildIdSchema.nullable(),
    keep: z.array(buildIdSchema),
    remove: z.array(buildIdSchema),
    archiveKeysToRemove: z.array(z.string().min(1)),
    objectKeysToRemove: z.array(z.string().min(1)),
  })
  .strict();

const remoteRetentionD1ReportSchema = z
  .object({
    projectedBuildsRemoved: z.int().nonnegative(),
    buildManifestsRemoved: z.int().nonnegative(),
    buildWarningsRemoved: z.int().nonnegative(),
    artifactsRemoved: z.int().nonnegative(),
    supersessionsRemoved: z.int().nonnegative(),
    nodesRemoved: z.int().nonnegative(),
    chunksRemoved: z.int().nonnegative(),
    ftsRowsRemoved: z.int().nonnegative(),
    projectedTablesRemoved: z.int().nonnegative(),
    projectedTableColumnsRemoved: z.int().nonnegative(),
    physicalTablesDropped: z.array(z.string().min(1)),
  })
  .strict();

const remoteRetentionR2ReportSchema = z
  .object({
    archiveKeysRemoved: z.array(z.string().min(1)),
    objectKeysRemoved: z.array(z.string().min(1)),
  })
  .strict();

export const remoteRetentionReceiptSchema = z
  .object({
    formatVersion: z.literal(1),
    receiptId: z.string().min(1),
    target: z.literal('cloudflare'),
    project: z.string().min(1),
    keepPrevious: z.int().nonnegative(),
    createdAt: isoTimestampSchema,
    state: z.enum(['planned', 'applying', 'applied', 'failed']),
    completedSteps: z.array(z.enum(['plan', 'd1', 'archives', 'objects'])),
    plan: remoteRetentionPlanSchema,
    d1: remoteRetentionD1ReportSchema,
    r2: remoteRetentionR2ReportSchema,
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;
export type DeploymentReceipt = z.infer<typeof deploymentReceiptSchema>;
export type RemoteRetentionReceipt = z.infer<typeof remoteRetentionReceiptSchema>;
