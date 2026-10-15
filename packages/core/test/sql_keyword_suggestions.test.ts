import { describe, expect, it } from 'vitest';
import { LoreError } from '../src/errors/index.js';
import { validateStatement } from '../src/sql/statement.js';

const cases = ['SELECT', 'WITH', 'VALUES'].flatMap((keyword) => [
  ...Array.from(keyword, (_, index) => ({
    keyword,
    kind: 'substitution',
    typo: `${keyword.slice(0, index)}X${keyword.slice(index + 1)}`,
  })),
  ...Array.from(keyword, (_, index) => ({
    keyword,
    kind: 'deletion',
    typo: `${keyword.slice(0, index)}${keyword.slice(index + 1)}`,
  })),
  ...Array.from({ length: keyword.length + 1 }, (_, index) => ({
    keyword,
    kind: 'insertion',
    typo: `${keyword.slice(0, index)}X${keyword.slice(index)}`,
  })),
  ...Array.from({ length: keyword.length - 1 }, (_, index) => ({
    keyword,
    kind: 'transposition',
    typo: `${keyword.slice(0, index)}${keyword[index + 1]}${keyword[index]}${keyword.slice(index + 2)}`,
  })),
]);

function rejection(sql: string): LoreError {
  try {
    validateStatement(sql);
  } catch (cause) {
    if (!(cause instanceof LoreError)) throw cause;
    return cause;
  }
  throw new Error(`Expected SQL rejection for ${sql}.`);
}

describe('leading SQL keyword suggestions', () => {
  it('names all supported leading forms in an invalid-keyword diagnostic', () => {
    expect(rejection('SELXCT 1').message).toContain('SELECT, WITH, or VALUES');
  });
  it.each(cases)(
    'suggests $keyword for $kind $typo while rejecting the statement',
    ({ keyword, typo }) => {
      const error = rejection(`${typo} 1`);
      expect(error.code).toBe('LORE_E_SQL_REJECTED');
      expect(error.message).toContain('not a SQL keyword');
      expect(error.remediation).toBe(`Did you mean ${keyword}?`);
    },
  );

  it.each(['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES(1)'])(
    'preserves successful statement validation for %s',
    (sql) => {
      expect(validateStatement(sql).sql).toBe(sql);
    },
  );

  it.each(['DELETE FROM t', 'DROP TABLE t', 'UPDATE t SET x=1', 'INSERT INTO t VALUES(1)'])(
    'preserves the read-only refusal for %s',
    (sql) => {
      const error = rejection(sql);
      expect(error.code).toBe('LORE_E_SQL_REJECTED');
      expect(error.remediation).toMatch(/read-only/i);
      expect(error.remediation).not.toContain('Did you mean');
    },
  );

  it.each(['SXLXCT 1', 'FROBNICATE 1'])('does not guess a distant keyword for %s', (sql) => {
    expect(rejection(sql).remediation).toBe('Check the spelling of the first word.');
  });
});
