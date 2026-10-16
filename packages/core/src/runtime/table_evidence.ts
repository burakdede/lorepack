import { z } from 'zod';
import { LoreError } from '../errors/lore-error.js';

const evidenceSchema = z
  .object({
    version: z.literal(1),
    formulaColumns: z.array(z.int().nonnegative()),
    conversionWarnings: z.array(
      z.object({ code: z.string().min(1), message: z.string() }).strict(),
    ),
  })
  .strict();

export function readTableEvidence(
  metadata: unknown,
  columnCount: number,
): {
  readonly formulas: readonly ('present' | 'absent' | 'unknown')[];
  readonly conversionWarnings: { code: string; message: string }[] | null;
} {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new LoreError('LORE_E_OBJECT_CORRUPT', 'The stored table metadata is invalid.', {
      remediation: 'Rebuild this version from its sources before reading its table evidence.',
    });
  }
  const raw = (metadata as Record<string, unknown>).tableEvidence;
  if (raw === undefined) {
    return {
      formulas: Array.from({ length: columnCount }, () => 'unknown' as const),
      conversionWarnings: null,
    };
  }
  const result = evidenceSchema.safeParse(raw);
  if (
    !result.success ||
    result.data.formulaColumns.some(
      (ordinal, index, columns) =>
        ordinal >= columnCount || (index > 0 && ordinal <= (columns[index - 1] as number)),
    )
  ) {
    throw new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      'The stored table conversion evidence is invalid.',
      {
        remediation: 'Rebuild this version from its sources before reading its table evidence.',
      },
    );
  }
  const present = new Set(result.data.formulaColumns);
  return {
    formulas: Array.from({ length: columnCount }, (_, ordinal) =>
      present.has(ordinal) ? 'present' : 'absent',
    ),
    conversionWarnings: result.data.conversionWarnings,
  };
}
