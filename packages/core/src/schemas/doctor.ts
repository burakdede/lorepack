import { z } from 'zod';

/**
 * What `lore doctor` reports, as a published contract.
 *
 * It is public for two reasons that both outlive the CLI. Phase 4's Studio Diagnostics route
 * (#69) renders these results over HTTP rather than reimplementing the checks, and a bug
 * report is asked for `lore doctor --json`, so the shape has to be stable enough for a
 * maintainer to read a stranger's output six months from now.
 *
 * The contract lives here, in `core`, for the same reason every other one does: the CLI, the
 * HTTP surface and any future consumer must not be able to disagree about it.
 */

export const checkStatusSchema = z.enum(['pass', 'warn', 'fail']);

export const checkResultSchema = z.object({
  /** Stable across releases, because a consumer filters and links on it. */
  id: z.string().min(1),
  title: z.string().min(1),
  status: checkStatusSchema,
  /** What was found, in the user's terms. */
  detail: z.string().min(1),
  /**
   * Exactly one concrete thing to do.
   *
   * Optional in the type and mandatory in spirit: a failing check without one has told the
   * user something they already knew from the failure that sent them here (architecture 6.9).
   */
  remediation: z.string().min(1).optional(),
  /** The measured values, so a bug report carries evidence rather than adjectives. */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const doctorReportSchema = z.object({
  /** The worst status of any check: one failure makes the report a failure. */
  status: checkStatusSchema,
  /** Absent when run outside a project, which is a supported thing to do. */
  project: z.string().nullable(),
  checks: z.array(checkResultSchema),
  counts: z.object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  }),
});

export type CheckStatus = z.infer<typeof checkStatusSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;
