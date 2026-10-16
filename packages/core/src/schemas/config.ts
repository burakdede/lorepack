import { z } from 'zod';
import { artifactStatusSchema, authoritySchema } from './common.js';

/** The generated lore.yaml is intentionally small. Everything else has a versioned default. */

export const ruleSchema = z
  .object({
    match: z.string().min(1).describe('Glob matched against canonical artifact paths'),
    status: artifactStatusSchema.optional(),
    authority: authoritySchema.optional(),
    supersedes: z.array(z.string().min(1)).optional(),
    replace: z
      .boolean()
      .optional()
      .describe('Replace inherited supersedes entries instead of merging them'),
  })
  .strict()
  .refine(
    (rule) =>
      rule.status !== undefined || rule.authority !== undefined || rule.supersedes !== undefined,
    { message: 'A rule must set at least one of status, authority, or supersedes' },
  );

export const contextProfileSchema = z.enum(['agent', 'coding', 'chat', 'deep']);

export const requiredSourceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (path) =>
          path === path.normalize('NFC') &&
          path
            .split('/')
            .every(
              (part) =>
                part !== '' && part !== '.' && part !== '..' && !/[\\:*?"<>|\p{Cc}]/u.test(part),
            ),
        'Use an exact canonical project-relative file path with forward slashes',
      ),
    sheets: z
      .array(z.string().min(1))
      .min(1)
      .refine(
        (sheets) => new Set(sheets).size === sheets.length,
        'Required sheet names must be unique',
      )
      .optional(),
  })
  .strict();

export const buildProfileSchema = z.enum(['permissive', 'strict']);

export const configSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, 'Project names avoid path and shell metacharacters'),
    sources: z.array(z.string().min(1)).min(1),
    build: z
      .object({
        profile: buildProfileSchema.optional(),
        required: z
          .array(requiredSourceSchema)
          .refine(
            (required) => new Set(required.map((source) => source.path)).size === required.length,
            'Declare each required artifact path once',
          )
          .optional(),
      })
      .strict()
      .optional(),
    rules: z.array(ruleSchema).optional(),
    context: z.object({ defaultProfile: contextProfileSchema.optional() }).strict().optional(),
    package: z
      .object({
        includeOriginals: z
          .boolean()
          .optional()
          .describe('Include original binary sources in the build. Off by default'),
      })
      .strict()
      .optional(),
    strictRules: z.boolean().optional().describe('Fail the build when a rule matches no artifact'),
  })
  .strict();

export type LoreConfig = z.infer<typeof configSchema>;
export type LoreRule = z.infer<typeof ruleSchema>;
export type ContextProfile = z.infer<typeof contextProfileSchema>;
