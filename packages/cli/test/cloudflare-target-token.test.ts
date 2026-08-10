import { describe, expect, it } from 'vitest';
import {
  isRetryableWranglerRemoteD1Failure,
  isWranglerD1TransactionControl,
  parseWranglerJson,
  renderWranglerSqlBatch,
  WranglerD1TransactionBatch,
  wranglerD1ExecutionMode,
} from '../src/commands/target.js';

describe('the Wrangler-backed Cloudflare target-token adapter, issue 282', () => {
  it('suppresses explicit transaction control statements for remote D1', () => {
    expect(isWranglerD1TransactionControl('BEGIN IMMEDIATE')).toBe(true);
    expect(isWranglerD1TransactionControl(' commit ')).toBe(true);
    expect(isWranglerD1TransactionControl('\nROLLBACK\n')).toBe(true);
    expect(wranglerD1ExecutionMode('BEGIN IMMEDIATE')).toBe('skip');
  });

  it('uses Wrangler commands for reads and SQL files for writes', () => {
    expect(isWranglerD1TransactionControl('BEGIN')).toBe(false);
    expect(isWranglerD1TransactionControl('SELECT 1')).toBe(false);
    expect(isWranglerD1TransactionControl('UPDATE active_build SET build_id = ?')).toBe(false);
    expect(wranglerD1ExecutionMode('SELECT 1')).toBe('command');
    expect(wranglerD1ExecutionMode('PRAGMA table_info(runtime_tokens)')).toBe('command');
    expect(wranglerD1ExecutionMode('UPDATE active_build SET build_id = ?')).toBe('file');
  });

  it('batches write statements across an explicit transaction', () => {
    const batch = new WranglerD1TransactionBatch();
    batch.begin();
    batch.stage("INSERT INTO demo VALUES ('alpha')");
    batch.stage("UPDATE demo SET name = 'beta' WHERE id = 1;");

    expect(batch.commit()).toBe(
      ["INSERT INTO demo VALUES ('alpha');", "UPDATE demo SET name = 'beta' WHERE id = 1;"].join(
        '\n',
      ),
    );
  });

  it('drops staged writes on rollback', () => {
    const batch = new WranglerD1TransactionBatch();
    batch.begin();
    batch.stage('DELETE FROM demo WHERE id = 1');
    batch.rollback();

    expect(batch.commit()).toBeNull();
  });

  it('terminates every statement in a batched SQL file', () => {
    expect(
      renderWranglerSqlBatch(['INSERT INTO demo VALUES (1)', 'DELETE FROM demo WHERE id = 1;']),
    ).toBe(['INSERT INTO demo VALUES (1);', 'DELETE FROM demo WHERE id = 1;'].join('\n'));
  });

  it('retries the transient remote D1 fetch failure seen in Cloudflare acceptance', () => {
    expect(isRetryableWranglerRemoteD1Failure('{"error":{"text":"fetch failed"}}')).toBe(true);
    expect(isRetryableWranglerRemoteD1Failure('Could not reach remote D1')).toBe(false);
  });

  it('parses Wrangler JSON after file-upload progress lines', () => {
    const parsed = parseWranglerJson(
      [
        '├ Checking if file needs uploading',
        '│',
        '├ 🌀 Uploading demo.sql',
        '│ 🌀 Uploading complete.',
        '│',
        '[',
        '  {',
        '    "results": [',
        '      {',
        '        "ok": 1',
        '      }',
        '    ],',
        '    "success": true',
        '  }',
        ']',
      ].join('\n'),
    );

    expect(parsed).toEqual([
      {
        results: [{ ok: 1 }],
        success: true,
      },
    ]);
  });
});
