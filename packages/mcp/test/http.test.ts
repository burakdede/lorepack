import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreFetch =
  vi.fn<(request: Request, options?: { parsedBody?: unknown }) => Promise<Response>>();
const close = vi.fn<() => Promise<void>>();
const createMcpHandler = vi.fn();
const createMcpServer = vi.fn();
const createMcpHonoApp = vi.fn();

let mountedHandler:
  | ((context: { req: { raw: Request }; get: (key: string) => unknown }) => Promise<Response>)
  | undefined;

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler,
}));

vi.mock('@modelcontextprotocol/hono', () => ({
  createMcpHonoApp,
}));

vi.mock('../src/server.js', () => ({
  createMcpServer,
}));

const { createMcpHttpHandler } = await import('../src/http.js');

beforeEach(() => {
  mountedHandler = undefined;
  coreFetch.mockReset();
  coreFetch.mockResolvedValue(new Response('ok'));
  close.mockReset();
  close.mockResolvedValue();
  createMcpHandler.mockReset();
  createMcpHandler.mockReturnValue({
    fetch: coreFetch,
    close,
  });
  createMcpServer.mockReset();
  createMcpServer.mockReturnValue({});
  createMcpHonoApp.mockReset();
  createMcpHonoApp.mockImplementation(() => ({
    all: (_path: string, handler: typeof mountedHandler) => {
      mountedHandler = handler;
    },
    fetch: async (request: Request) => {
      if (mountedHandler === undefined) {
        throw new Error('the /mcp route was not mounted');
      }
      const parsedBody =
        request.headers.get('content-type') === 'application/json'
          ? await request.clone().json()
          : undefined;
      return await mountedHandler({
        req: { raw: request },
        get: (key: string) => (key === 'parsedBody' ? parsedBody : undefined),
      });
    },
  }));
});

describe('createMcpHttpHandler', () => {
  it('forwards the mounted /mcp request object unchanged, so request abort reaches the SDK', async () => {
    const handler = createMcpHttpHandler({} as never);
    const controller = new AbortController();
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const request = new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    await handler.fetch(request);

    expect(coreFetch).toHaveBeenCalledTimes(1);
    const [seenRequest, seenOptions] = coreFetch.mock.calls[0] ?? [];
    expect(seenRequest).toBe(request);
    expect(seenRequest.signal.aborted).toBe(false);
    controller.abort('client disconnected');
    expect(seenRequest.signal.aborted).toBe(true);
    expect(seenOptions).toEqual({ parsedBody: body });
  });
});
