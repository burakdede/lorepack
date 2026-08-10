import { describe, expect, it } from 'vitest';
import {
  isRetryableWranglerRemoteR2Failure,
  isWranglerD1TransactionControl,
  isWranglerMissingObjectFailure,
  parseWranglerJson,
  renderWranglerSqlBatch,
  WranglerD1TransactionBatch,
  wranglerD1ExecutionMode,
} from '../src/services/cloudflare-target.js';

describe('the Wrangler-backed Cloudflare D1 adapter, issue 280', () => {
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

  it('recognizes missing-object errors from Wrangler R2 reads', () => {
    expect(isWranglerMissingObjectFailure('The specified key does not exist.')).toBe(true);
    expect(isWranglerMissingObjectFailure('No such object')).toBe(true);
    expect(isWranglerMissingObjectFailure('fetch failed')).toBe(false);
  });

  it('retries transient remote R2 hostname-resolution failures', () => {
    expect(
      isRetryableWranglerRemoteR2Failure(
        "Unable to resolve Cloudflare's API hostname (api.cloudflare.com or dash.cloudflare.com).",
      ),
    ).toBe(true);
    expect(isRetryableWranglerRemoteR2Failure('{"error":{"text":"fetch failed"}}')).toBe(true);
    expect(isRetryableWranglerRemoteR2Failure('The specified key does not exist.')).toBe(false);
  });
});
