import { z } from 'zod';
import {
  artifactStatusSchema,
  buildIdSchema,
  canonicalPathSchema,
  capabilitySchema,
  columnTypeSchema,
  isoTimestampSchema,
  sourceLocatorSchema,
} from './common.js';
import { contextProfileSchema } from './config.js';

/**
 * Runtime request and response contracts. MCP tool schemas, the REST bodies and the SDK
 * types all derive from these, so a capability cannot exist in one interface and not
 * another. The implementations arrive in Phase 2; the contract is fixed here.
 */

/** Freshness travels with every result, so a consumer never has to ask. */
export const sourceStateSchema = z.enum(['clean', 'dirty', 'unknown']);

const responseEnvelope = {
  buildId: buildIdSchema,
  sourceState: sourceStateSchema,
};

export const searchRequestSchema = z
  .object({
    query: z.string().min(1).max(1000),
    limit: z.int().positive().max(100).default(10),
    includeArchived: z.boolean().default(false),
    pathGlob: z.string().optional(),
    fileType: z.string().optional(),
    status: z.array(artifactStatusSchema).optional(),
    debug: z.boolean().default(false),
  })
  .strict();

export const searchHitSchema = z
  .object({
    chunkId: z.string().min(1),
    artifactId: z.string().min(1),
    score: z.number(),
    excerpt: z.string(),
    headingPath: z.array(z.string()),
    status: artifactStatusSchema,
    labels: z.array(z.enum(['draft', 'archived', 'superseded'])),
    locator: sourceLocatorSchema,
    scoreComponents: z.record(z.string(), z.number()).optional(),
  })
  .strict();

export const searchResultSchema = z
  .object({
    ...responseEnvelope,
    hits: z.array(searchHitSchema),
    totalIndexedChunks: z.int().nonnegative(),
  })
  .strict();

export const taskContextRequestSchema = z
  .object({
    task: z.string().min(1).max(4000),
    profile: contextProfileSchema.optional(),
    budget: z.int().min(1000).max(200_000).optional(),
    includeArchived: z.boolean().default(false),
    filters: z
      .array(z.object({ kind: z.enum(['path', 'type', 'status']), value: z.string() }).strict())
      .optional(),
  })
  .strict();

export const contextItemSchema = z
  .object({
    chunkId: z.string().min(1),
    text: z.string(),
    estimatedTokens: z.int().nonnegative(),
    headingPath: z.array(z.string()),
    labels: z.array(z.enum(['draft', 'archived', 'superseded'])),
    locator: sourceLocatorSchema,
  })
  .strict();

export const omittedItemSchema = z
  .object({
    chunkId: z.string().min(1),
    reason: z.enum(['budget', 'duplicate', 'diversity', 'superseded', 'archived', 'filtered']),
    estimatedTokens: z.int().nonnegative(),
    locator: sourceLocatorSchema,
  })
  .strict();

export const contextBundleSchema = z
  .object({
    ...responseEnvelope,
    task: z.string(),
    profile: contextProfileSchema,
    budget: z.int().positive(),
    estimatedTokens: z.int().nonnegative().describe('Conservative estimate, never an exact count'),
    reservedTokens: z.int().nonnegative(),
    overview: z.array(contextItemSchema),
    selected: z.array(contextItemSchema),
    tables: z.array(z.object({ tableId: z.string(), name: z.string() }).strict()),
    alternatives: z.array(contextItemSchema),
    omitted: z.array(omittedItemSchema),
    citations: z.array(sourceLocatorSchema),
  })
  .strict()
  .refine((bundle) => bundle.estimatedTokens <= bundle.budget, {
    message: 'A bundle may never exceed its budget',
  });

export const sourceReadRequestSchema = z
  .object({
    artifactId: z.string().min(1).optional(),
    path: canonicalPathSchema.optional(),
    lineStart: z.int().positive().optional(),
    lineEnd: z.int().positive().optional(),
    headingPath: z.array(z.string()).optional(),
    page: z.int().positive().optional(),
  })
  .strict()
  .refine((req) => req.artifactId !== undefined || req.path !== undefined, {
    message: 'Provide either an artifactId or a path',
  });

export const sourceReadResultSchema = z
  .object({
    ...responseEnvelope,
    text: z.string(),
    truncated: z.boolean().describe('Truncation is always explicit, never silent'),
    locator: sourceLocatorSchema,
  })
  .strict();

export const tableColumnSchema = z
  .object({ name: z.string().min(1), type: columnTypeSchema, nullable: z.boolean() })
  .strict();

export const tableDescriptionSchema = z
  .object({
    ...responseEnvelope,
    tableId: z.string().min(1),
    name: z.string().min(1),
    sheet: z.string().optional(),
    columns: z.array(tableColumnSchema),
    rowCount: z.int().nonnegative(),
    sample: z.array(z.record(z.string(), z.unknown())),
    locator: sourceLocatorSchema,
  })
  .strict();

export const tableQueryRequestSchema = z
  .object({
    tableId: z.string().min(1),
    sql: z.string().min(1).max(100_000).describe('Exactly one SELECT or WITH ... SELECT'),
    limit: z.int().positive().max(10_000).optional(),
  })
  .strict();

export const tableQueryResultSchema = z
  .object({
    ...responseEnvelope,
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.int().nonnegative(),
    truncated: z.boolean(),
    locator: sourceLocatorSchema,
  })
  .strict();

export const buildDescriptionSchema = z
  .object({
    ...responseEnvelope,
    projectName: z.string().min(1),
    shortBuildId: z.string().min(1),
    capabilities: z.array(capabilitySchema),
    counts: z
      .object({
        artifacts: z.int().nonnegative(),
        nodes: z.int().nonnegative(),
        chunks: z.int().nonnegative(),
        tables: z.int().nonnegative(),
        tableRows: z.int().nonnegative(),
      })
      .strict(),
    warningCount: z.int().nonnegative(),
    schemaVersion: z.int().positive(),
    compilerVersion: z.string().min(1),
    /**
     * When the build was created, where the serving backend records it. Optional because
     * a sealed build deliberately carries no wall-clock time: identical content must
     * produce identical bytes, so this is operational state, not build content.
     */
    createdAt: isoTimestampSchema.optional(),
  })
  .strict();

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SourceState = z.infer<typeof sourceStateSchema>;
export type TaskContextRequest = z.infer<typeof taskContextRequestSchema>;
export type ContextBundle = z.infer<typeof contextBundleSchema>;
export type SourceReadRequest = z.infer<typeof sourceReadRequestSchema>;
export type SourceReadResult = z.infer<typeof sourceReadResultSchema>;
export type TableQueryRequest = z.infer<typeof tableQueryRequestSchema>;
export type TableQueryResult = z.infer<typeof tableQueryResultSchema>;
export type TableDescription = z.infer<typeof tableDescriptionSchema>;
export type BuildDescription = z.infer<typeof buildDescriptionSchema>;
