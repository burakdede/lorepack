import { z } from 'zod';

/**
 * Shared building blocks. Zod is the single source of truth: the runtime validator, the
 * committed public JSON Schema, the REST contract and the MCP tool schemas are all
 * generated from these, so they cannot drift apart.
 */

export const buildIdSchema = z
  .string()
  .regex(/^lore_[0-9a-f]{64}$/, 'A build id is lore_ followed by a full lowercase sha256')
  .describe('Content-derived build identifier');

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'A sha256 digest is 64 lowercase hexadecimal characters');

export const canonicalPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\\'), 'Canonical paths use POSIX separators')
  .refine((value) => !value.startsWith('/'), 'Canonical paths are relative to a source root')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'Canonical paths carry no drive letter')
  .describe('POSIX-style path relative to a source root');

export const artifactStatusSchema = z.enum(['active', 'draft', 'archived']);

export const authoritySchema = z
  .int()
  .min(0)
  .max(100)
  .describe('User-declared ranking hint. Not a measure of truth');

export const capabilitySchema = z.enum([
  'lexical-search',
  'structured-context',
  'table-query',
  'semantic-search',
]);

export const columnTypeSchema = z.enum(['text', 'integer', 'real', 'boolean', 'date', 'unknown']);

export const isoTimestampSchema = z.iso.datetime({ offset: true });

/** Provenance. A result without one is invalid, so the shape is shared everywhere. */
export const sourceLocatorSchema = z
  .object({
    artifactId: z.string().min(1),
    relativePath: canonicalPathSchema,
    page: z.int().positive().optional(),
    headingPath: z.array(z.string()).optional(),
    sheet: z.string().optional(),
    cellRange: z.string().optional(),
    lineStart: z.int().positive().optional(),
    lineEnd: z.int().positive().optional(),
  })
  .strict()
  .describe('Exact location of content within a source artifact');

export const embeddingProfileSchema = z
  .object({
    modelId: z.string().min(1),
    revision: z.string().min(1),
    tokenizer: z.string().min(1),
    pooling: z.enum(['mean', 'cls']),
    normalized: z.boolean(),
    dimensions: z.int().positive(),
    valueType: z.literal('float32'),
  })
  .strict()
  .describe('Complete embedding identity. Matching dimensions alone is not compatibility');

export type SourceLocator = z.infer<typeof sourceLocatorSchema>;
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;
