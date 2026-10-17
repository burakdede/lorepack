import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

const MAXIMUM_EVENTS = 64;

interface RequestIdentity {
  readonly origin: string;
  readonly method: string;
  readonly path: string;
}

interface RequestState {
  readonly id: number;
  socket?: Socket;
}

interface SocketState {
  readonly id: number;
  readonly localPort: number | null;
  readonly remotePort: number | null;
  uses: number;
  completedAt: number | null;
}

interface DiagnosticMessage {
  readonly request: RequestIdentity;
  readonly socket?: Socket;
  readonly response?: { readonly statusCode: number };
  readonly error?: { readonly name?: string; readonly code?: string; readonly syscall?: string };
}

export function observeHttp(origin: string) {
  const began = performance.now();
  const requests = new WeakMap<RequestIdentity, RequestState>();
  const sockets = new WeakMap<Socket, SocketState>();
  const events: Record<string, unknown>[] = [];
  let nextRequest = 0;
  let nextSocket = 0;
  let dropped = 0;
  let stopped = false;

  const names = [
    ['undici:request:create', 'created'],
    ['undici:client:sendHeaders', 'send headers'],
    ['undici:request:bodySent', 'body sent'],
    ['undici:request:headers', 'response headers'],
    ['undici:request:trailers', 'response complete'],
    ['undici:request:error', 'error'],
  ] as const;
  const subscriptions = names.map(([name, event]) => {
    const source = channel(name);
    const listener = (value: unknown) => {
      const message = value as DiagnosticMessage;
      const request = message.request;
      if (stopped || request.origin !== origin) return;
      const now = performance.now();
      let state = requests.get(request);
      if (state === undefined) {
        state = { id: ++nextRequest };
        requests.set(request, state);
      }
      if (message.socket !== undefined) state.socket = message.socket;
      const socket = state.socket;
      let socketState = socket === undefined ? undefined : sockets.get(socket);
      if (socket !== undefined && socketState === undefined) {
        socketState = {
          id: ++nextSocket,
          localPort: socket.localPort ?? null,
          remotePort: socket.remotePort ?? null,
          uses: 0,
          completedAt: null,
        };
        sockets.set(socket, socketState);
      }
      if (event === 'send headers' && socketState !== undefined) socketState.uses += 1;
      const previousCompletedAt = socketState?.completedAt;
      if (event === 'response complete' && socketState !== undefined) socketState.completedAt = now;
      events.push({
        event,
        elapsedMs: Math.round(now - began),
        requestId: state.id,
        method: request.method,
        path: request.path.split('?')[0],
        ...(message.response === undefined ? {} : { status: message.response.statusCode }),
        ...(socket === undefined || socketState === undefined
          ? {}
          : {
              socketId: socketState.id,
              socketUses: socketState.uses,
              localPort: socketState.localPort,
              remotePort: socketState.remotePort,
              bytesRead: socket.bytesRead,
              bytesWritten: socket.bytesWritten,
              destroyed: socket.destroyed,
              readableEnded: socket.readableEnded,
              writableEnded: socket.writableEnded,
              sincePreviousResponseMs:
                previousCompletedAt == null ? null : Math.round(now - previousCompletedAt),
            }),
        ...(message.error === undefined
          ? {}
          : {
              errorName: message.error.name ?? null,
              errorCode: message.error.code ?? null,
              syscall: message.error.syscall ?? null,
            }),
      });
      if (events.length > MAXIMUM_EVENTS) {
        events.shift();
        dropped += 1;
      }
    };
    source.subscribe(listener);
    return { source, listener };
  });
  return {
    capture() {
      return { dropped, events: events.map((event) => ({ ...event })) };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const { source, listener } of subscriptions) source.unsubscribe(listener);
    },
  };
}
