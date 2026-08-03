import { LoreClient } from '@lorepack/sdk';
import { describe, expect, it } from 'vitest';

/**
 * The SDK in a browser, which is where it spent two phases being broken (#196).
 *
 * `fetch` is a method of `Window`, and a browser rejects a call whose receiver is anything
 * else with "Illegal invocation" before the request is made. The client stored it as a field
 * and called `this.#fetch(...)`, which makes the client the receiver. Node does not care
 * about receivers here, so every existing test passed while nothing in a browser could work.
 *
 * The fix is one `bind`. What matters is that this file makes the browser's rule the thing
 * under test, rather than trusting that Node's tolerance means the same code runs anywhere.
 */

/**
 * A `fetch` that behaves the way a browser's does: usable only when its receiver is the
 * global object.
 */
function browserLikeFetch(): typeof globalThis.fetch {
  const implementation = function (this: unknown, input: string | URL): Promise<Response> {
    if (this !== globalThis && this !== undefined) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'ok', url: String(input) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return implementation as unknown as typeof globalThis.fetch;
}

describe('a fetch that insists on its receiver', () => {
  it('is called correctly, so the client works in a browser', async () => {
    const client = new LoreClient({
      baseUrl: 'http://127.0.0.1:43110',
      fetch: browserLikeFetch(),
    });

    // Before #196 this threw `Illegal invocation` rather than resolving.
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
  });

  it('still accepts an arrow function, which has no receiver to bind', async () => {
    let seen = '';
    const client = new LoreClient({
      baseUrl: 'http://127.0.0.1:43110',
      fetch: async (input) => {
        seen = String(input);
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // Binding an arrow function is a no-op, so injection keeps working exactly as before.
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
    expect(seen).toBe('http://127.0.0.1:43110/health');
  });

  it('still accepts a function already bound to something else', async () => {
    const owner = {
      calls: 0,
      async send(): Promise<Response> {
        this.calls += 1;
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };

    const client = new LoreClient({
      baseUrl: 'http://127.0.0.1:43110',
      fetch: owner.send.bind(owner) as unknown as typeof globalThis.fetch,
    });

    // Rebinding an already-bound function cannot change its receiver, so a caller that
    // deliberately bound one keeps the behaviour they asked for.
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
    expect(owner.calls).toBe(1);
  });
});
