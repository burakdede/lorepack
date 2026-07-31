import type { z } from 'zod';
import { buildManifestSchema, buildReceiptSchema, lockfileSchema } from './build.js';
import { configSchema } from './config.js';
import { buildDiffSchema } from './diff.js';
import { deploymentReceiptSchema, planSchema } from './plan.js';
import {
  buildDescriptionSchema,
  contextBundleSchema,
  searchRequestSchema,
  searchResultSchema,
  sourceReadRequestSchema,
  sourceReadResultSchema,
  tableDescriptionSchema,
  tableQueryRequestSchema,
  tableQueryResultSchema,
  taskContextRequestSchema,
} from './runtime.js';
import { statusSchema } from './status.js';

/**
 * Every schema published under schemas/. The generator walks this registry, so adding a
 * public contract means adding one entry here and regenerating; the drift check then
 * keeps the committed JSON Schema honest.
 */
export const PUBLIC_SCHEMAS = {
  'lore-config': configSchema,
  'lore-lock': lockfileSchema,
  'build-manifest': buildManifestSchema,
  'build-receipt': buildReceiptSchema,
  'build-diff': buildDiffSchema,
  plan: planSchema,
  status: statusSchema,
  'deployment-receipt': deploymentReceiptSchema,
  'search-request': searchRequestSchema,
  'search-result': searchResultSchema,
  'task-context-request': taskContextRequestSchema,
  'context-bundle': contextBundleSchema,
  'source-read-request': sourceReadRequestSchema,
  'source-read-result': sourceReadResultSchema,
  'table-description': tableDescriptionSchema,
  'table-query-request': tableQueryRequestSchema,
  'table-query-result': tableQueryResultSchema,
  'build-description': buildDescriptionSchema,
} as const satisfies Record<string, z.ZodType>;

export type PublicSchemaName = keyof typeof PUBLIC_SCHEMAS;
