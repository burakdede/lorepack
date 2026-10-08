import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../scripts/rag-benchmark-security.mjs';

describe('RAG benchmark secret handling', () => {
  it('redacts the API key and bearer values from errors', () => {
    const message = redactSecrets(
      'request Bearer secret-token failed: secret-token',
      'secret-token',
    );
    expect(message).not.toContain('secret-token');
    expect(message).toContain('[REDACTED]');
  });

  it('does not alter errors when no secret is configured', () => {
    expect(redactSecrets('provider failed', undefined)).toBe('provider failed');
  });
});
