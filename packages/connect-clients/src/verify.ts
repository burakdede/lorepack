import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ConnectionCheck } from './port.js';

/**
 * Confirming that the thing we just configured actually answers.
 *
 * Architecture 6.6 step 9 makes verification part of connecting rather than an afterthought,
 * and the reason is that every failure mode here is silent otherwise: a config file written
 * correctly, pointing at a binary that is not on the path, looks exactly like success until
 * a person asks their agent a question and gets nothing.
 *
 * ## Asking for the modern era is not optional
 *
 * `ClientOptions.versionNegotiation.mode` defaults to `'legacy'`, so a client written the
 * obvious way negotiates the removed `initialize` handshake and `client.discover()` fails
 * locally before anything reaches the wire. A verifier built that way would confirm the
 * fallback path and report success for a server that does not speak the current revision at
 * all. The amendment on #58 records the measurement; #189 is where the same assumption hid a
 * real defect for weeks.
 *
 * A passing `tools/list` is likewise not evidence of the modern era: a legacy-era server
 * ignores an unrecognized `_meta` and answers normally. Only `server/discover` settles it.
 */

export interface VerifyOptions {
  readonly executable: string;
  readonly args: readonly string[];
  /** Bound, because a server that never answers must fail rather than hang a connect. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function verifyStdioServer(options: VerifyOptions): Promise<ConnectionCheck> {
  const transport = new StdioClientTransport({
    command: options.executable,
    args: [...options.args],
    stderr: 'pipe',
  });

  // `'auto'` probes `server/discover` and falls back to the handshake for a 2025-era server,
  // which is exactly the pair of paths a connector has to work across.
  const client = new Client(
    { name: 'lorepack-connect-verify', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
  );

  try {
    await withTimeout(client.connect(transport), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'spawn');
  } catch (error) {
    return {
      ok: false,
      step: 'spawn',
      // Named as our side, because it is: the command in the config is one we wrote.
      detail: `The server could not be started: ${message(error)}. Check that \`${options.executable}\` is on the path.`,
    };
  }

  let protocolVersion: string | undefined;
  try {
    const discovered = await withTimeout(
      client.discover(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'discover',
    );
    protocolVersion = discovered.supportedVersions?.[0];
  } catch {
    // Not a failure. A 2025-era server has no `server/discover` and is still perfectly
    // usable, which is the backward compatibility the specification requires us to keep.
    protocolVersion = undefined;
  }

  try {
    const listed = await withTimeout(
      client.listTools(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'tools',
    );
    if (listed.tools.length === 0) {
      return {
        ok: false,
        step: 'tools',
        detail:
          'The server started and offered no tools, so the client would have nothing to call.',
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      };
    }

    return {
      ok: true,
      step: 'none',
      detail: `Answered with ${listed.tools.length} tools${
        protocolVersion === undefined
          ? ' over the backward-compatibility path'
          : ` on protocol ${protocolVersion}`
      }.`,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    };
  } catch (error) {
    return {
      ok: false,
      step: 'tools',
      detail: `The server started but did not list its tools: ${message(error)}`,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${step} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
