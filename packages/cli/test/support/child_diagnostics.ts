import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface ChildOutput {
  readonly stdout?: string;
  readonly stderr?: string;
}

function buffered(stream: Readable | null): string {
  const chunk = stream?.read() as Buffer | string | null | undefined;
  return (chunk?.toString() ?? '').slice(-16000);
}

export function scheduleDeadlineDiagnostics(
  callback: () => void,
  deadlineMs: number,
  leadMs = 5_000,
): () => void {
  const timer = setTimeout(callback, Math.max(0, deadlineMs - leadMs));
  return () => clearTimeout(timer);
}

export function observeChild(label: string, child: ChildProcess, readOutput?: () => ChildOutput) {
  return {
    label,
    child,
    capture() {
      const stdoutBufferedBytes = child.stdout?.readableLength ?? 0;
      const stderrBufferedBytes = child.stderr?.readableLength ?? 0;
      const stdoutFlowing = child.stdout?.readableFlowing ?? null;
      const stderrFlowing = child.stderr?.readableFlowing ?? null;
      const output = readOutput?.() ?? {};
      return {
        stdoutBufferedBytes,
        stderrBufferedBytes,
        stdoutFlowing,
        stderrFlowing,
        stdout: (output.stdout ?? buffered(child.stdout)).slice(-16000),
        stderr: (output.stderr ?? buffered(child.stderr)).slice(-16000),
      };
    },
  };
}
