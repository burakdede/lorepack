import { isDeepStrictEqual } from 'node:util';
import { buildDescriptionSchema, LoreError, sourceReadResultSchema } from '@lorepack/core';
import type { Client } from '@modelcontextprotocol/client';
import { resolveExecutable } from './executable.js';
import type { ConnectionCheck, ConnectionExpectation, ReadConnectionExpectation } from './port.js';
import {
  createVerificationProcessHost,
  VERIFY_TOKEN_ENV,
  verificationBridgeEntry,
} from './verify_process.js';

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
  readonly expected: ReadConnectionExpectation;
  /** Bound, because a server that never answers must fail rather than hang a connect. */
  readonly timeoutMs?: number;
  readonly diagnostic?: (event: VerifyDiagnostic) => void;
}

export type VerifyDiagnostic =
  | { readonly event: 'launch'; readonly ordinal: number; readonly pid: number | null }
  | {
      readonly event: 'exit';
      readonly ordinal: number;
      readonly pid: number | null;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly memoryObserverFailure: boolean;
    }
  | {
      readonly event: 'connected';
      readonly era: string | null;
      readonly version: string | null;
      readonly probeVersions: readonly string[];
    }
  | { readonly event: 'discover-result'; readonly versions: readonly string[] }
  | {
      readonly event: 'discover-error';
      readonly name: 'Error' | 'OtherError';
      readonly code: number | null;
    };

function observe(options: VerifyOptions, event: () => VerifyDiagnostic): void {
  if (options.diagnostic === undefined) return;
  try {
    options.diagnostic(event());
  } catch {
    // Diagnostics must not change verification or process cleanup.
  }
}

function safeProtocol(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '<invalid>';
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function verifyStdioServer(options: VerifyOptions): Promise<ConnectionCheck> {
  // Found on `PATH` and started by absolute path, so a `lorepack.cmd` planted in the project
  // is never what runs (#577). See `executable.ts`.
  const command = resolveExecutable(options.executable);
  if (command === undefined) {
    return {
      ok: false,
      step: 'spawn',
      detail: `The server could not be started: \`${options.executable}\` was not found on the PATH. Check that \`${options.executable}\` is on the path.`,
    };
  }

  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio'),
  ]);
  let ownership: Awaited<ReturnType<typeof createVerificationProcessHost>>;
  let bridge: string;
  try {
    bridge = verificationBridgeEntry();
    ownership = await createVerificationProcessHost(
      command,
      options.args,
      getDefaultEnvironment(),
      options.diagnostic === undefined
        ? undefined
        : (ordinal, pid) => observe(options, () => ({ event: 'launch', ordinal, pid })),
      options.diagnostic === undefined
        ? undefined
        : (ordinal, pid, code, signal, memoryObserverFailure) =>
            observe(options, () => ({
              event: 'exit',
              ordinal,
              pid,
              code,
              signal,
              memoryObserverFailure,
            })),
    );
  } catch (error) {
    return { ok: false, step: 'spawn', detail: `Verification could not start: ${message(error)}` };
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridge, ownership.endpoint],
    env: { [VERIFY_TOKEN_ENV]: ownership.token },
    stderr: 'pipe',
  });

  // `'auto'` probes `server/discover` and falls back to the handshake for a 2025-era server,
  // which is exactly the pair of paths a connector has to work across.
  const client = new Client(
    { name: 'lorepack-connect-verify', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
  );

  // Held so the cleanup can wait for it. In `'auto'` mode the SDK probes on a disposable
  // sibling process and reaps it only when this promise settles, so returning before it does
  // would leave that sibling running.
  const connecting = client.connect(transport);
  connecting.catch(() => undefined);

  let result: ConnectionCheck;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    result = await check(client, connecting, options);
  } finally {
    // Every path, not only success. A server stuck in a long `--ensure-current` build holds
    // the project lock, and a timeout that walked away from it left it holding the lock after
    // `connect` had returned (#578). Closing the session transport also aborts a probe still
    // in flight, which is what lets `connecting` settle and reap the sibling.
    await ownership.close().catch((error: unknown) => {
      cleanupFailure = { error };
    });
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await connecting.catch(() => undefined);
  }
  return cleanupFailure === undefined
    ? result
    : {
        ok: false,
        step: 'spawn',
        detail: `Verification could not confirm server cleanup: ${message(cleanupFailure.error)}`,
      };
}

async function check(
  client: Client,
  connecting: Promise<void>,
  options: VerifyOptions,
): Promise<ConnectionCheck> {
  try {
    await withTimeout(connecting, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'spawn');
    observe(options, () => ({
      event: 'connected',
      era: client.getProtocolEra() ?? null,
      version: safeProtocol(client.getNegotiatedProtocolVersion()),
      probeVersions: (client.getDiscoverResult()?.supportedVersions ?? [])
        .slice(0, 4)
        .map((version) => safeProtocol(version) ?? '<missing>'),
    }));
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
    observe(options, () => ({
      event: 'discover-result',
      versions: (discovered.supportedVersions ?? [])
        .slice(0, 4)
        .map((version) => safeProtocol(version) ?? '<missing>'),
    }));
    protocolVersion = discovered.supportedVersions?.[0];
  } catch (error) {
    observe(options, () => {
      const rawCode =
        error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return {
        event: 'discover-error',
        name: error instanceof Error ? 'Error' : 'OtherError',
        code: typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode : null,
      };
    });
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

    return await proveRead(client, options, listed.tools.length, protocolVersion);
  } catch (error) {
    return {
      ok: false,
      step: 'tools',
      detail: `The server started but did not list its tools: ${message(error)}`,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
    };
  }
}

async function proveRead(
  client: Client,
  options: VerifyOptions,
  toolCount: number,
  protocolVersion: string | undefined,
): Promise<ConnectionCheck> {
  const protocol = protocolVersion === undefined ? {} : { protocolVersion };
  const fail = (step: 'build' | 'source', detail: string): ConnectionCheck => ({
    ok: false,
    step,
    detail,
    ...protocol,
  });
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let expected: ConnectionExpectation;
  try {
    expected = await withTimeout(options.expected(), timeout, 'expected build');
  } catch (error) {
    const remediation =
      error instanceof LoreError && error.remediation !== undefined
        ? error.remediation
        : 'Run lorepack build in that project and reconnect.';
    return fail(
      'build',
      `The intended project could not be verified: ${message(error)} ${remediation}`,
    );
  }

  try {
    const reply = await withTimeout(
      client.callTool({ name: 'lore_build_info', arguments: {} }),
      timeout,
      'build',
    );
    if (reply.isError === true) throw new Error('lore_build_info returned an error.');
    const build = buildDescriptionSchema.parse(reply.structuredContent);
    if (build.buildId !== expected.buildId) {
      return fail(
        'build',
        `The server answered for ${build.buildId}, but this project expects ${expected.buildId}. Check the configured project path and reconnect.`,
      );
    }
  } catch (error) {
    return fail(
      'build',
      `The server did not identify the expected build: ${message(error)} Check the project path, run lorepack build and reconnect.`,
    );
  }

  try {
    const reply = await withTimeout(
      client.callTool({
        name: 'lore_read_source',
        arguments: { ...expected.request, buildId: expected.buildId },
      }),
      timeout,
      'source',
    );
    if (reply.isError === true) throw new Error('lore_read_source returned an error.');
    const source = sourceReadResultSchema.parse(reply.structuredContent);
    if (source.text.trim().length === 0) {
      return fail(
        'source',
        'The build has no readable content at the known source. Add a supported document, run lorepack build and reconnect.',
      );
    }
    if (
      source.buildId !== expected.buildId ||
      source.text !== expected.source.text ||
      source.truncated !== expected.source.truncated ||
      !isDeepStrictEqual(source.locator, expected.source.locator)
    ) {
      return fail(
        'source',
        `The cited source did not match ${expected.buildId}. Check the project path and rebuild the intended project before reconnecting.`,
      );
    }
    return {
      ok: true,
      step: 'none',
      ...protocol,
      detail: `Answered with ${toolCount} tools${protocolVersion === undefined ? ' over the backward-compatibility path' : ` on protocol ${protocolVersion}`}. Verified ${source.buildId} with a cited read of ${source.locator.relativePath}.`,
      proof: { buildId: source.buildId, locator: source.locator },
    };
  } catch (error) {
    return fail(
      'source',
      `The server could not read the known source: ${message(error)} Check the project path, run lorepack build and reconnect.`,
    );
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
