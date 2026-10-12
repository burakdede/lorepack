import { z } from 'zod';
import { buildIdSchema, runtimeIdentitySchema, sha256Schema } from './common.js';
import { executionPolicySchema, executionSelectionSchema } from './execution.js';

export { MAXIMUM_CONTEXT_RECEIPT_BYTES } from '../runtime/limits.js';

export const contextReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    canonicalizationVersion: z.literal(1),
    receiptId: z.string().regex(/^context_receipt_[a-f0-9]{64}$/),
    boundary: z.literal('lorepack-emitted-content'),
    assurance: z.literal('integrity-only'),
    ...runtimeIdentitySchema.shape,
    buildId: buildIdSchema,
    requestDigest: sha256Schema,
    requestRetained: z.boolean(),
    request: executionSelectionSchema.optional(),
    execution: z
      .object({
        policyId: z.string().regex(/^policy_[a-f0-9]{64}$/),
        selectionId: z.string().regex(/^selection_[a-f0-9]{64}$/),
        policy: executionPolicySchema,
      })
      .strict(),
    evidencePrecision: z.literal('declared-per-item'),
    payloadFormat: z.enum(['json', 'markdown', 'mcp-content']),
    payloadDigest: sha256Schema,
    payloadBytes: z
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    payloadRetained: z.literal(false),
  })
  .strict()
  .refine((receipt) => receipt.requestRetained === (receipt.request !== undefined), {
    message: 'Request retention must describe the actual captured request',
    path: ['requestRetained'],
  });

export type ContextReceipt = z.infer<typeof contextReceiptSchema>;
