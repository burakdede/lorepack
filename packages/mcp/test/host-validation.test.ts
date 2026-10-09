import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { describe, expect, it } from 'vitest';

describe('MCP HTTP host validation', () => {
  it('refuses a non-loopback Host even when the server listens on all interfaces', async () => {
    const app = createMcpHonoApp({
      host: '0.0.0.0',
      allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
    });

    const response = await app.request('/mcp', {
      headers: { Host: 'attacker.example' },
    });

    expect(response.status).toBe(403);
  });

  it('allows the loopback names used by local clients', async () => {
    const app = createMcpHonoApp({
      host: '0.0.0.0',
      allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
    });

    for (const host of ['127.0.0.1:4321', 'localhost:4321', '[::1]:4321']) {
      const response = await app.request('/mcp', { headers: { Host: host } });
      expect(response.status, host).not.toBe(403);
    }
  });
});
