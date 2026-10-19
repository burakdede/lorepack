# Own the real processes used by connection verification

## Status

Accepted.

## Context

The SDK hides its disposable stdio probe. Reaping a `.cmd` or shell wrapper alone
can leave the Node server alive with a project lock. Transport subclassing changes
the SDK's legacy fallback behavior; private constructor/reaper hooks would couple
Lorepack to unsupported lifecycle details. Both OS wrapper leaks were reproduced.

## Decision

Keep the SDK's exact base transport and automatic negotiation. It starts Node bridges
that authenticate to a private local IPC host. The host starts and records the actual
server children using the SDK's default environment and cross-spawn's existing Windows
shim handling. The authentication nonce belongs only to bridges. Protocol and stderr
use separate channels with native stream backpressure.

Serialize actual launches until the previous owned tree is reaped. An input half-close
permits graceful server shutdown. The bridge's separate lifetime channel distinguishes
SDK probe disposal from a server closing stderr early. Stop accepting new launches
before final cleanup, reap all owned trees, then close SDK transports and await connect.

Use a detached POSIX process group or the absolute Windows system taskkill executable
with the owned root PID and `/T /F`. Protocol deadlines and retries stay unchanged.
Cleanup has bounded waits and a failure cannot return a successful connection check.
The compiled bridge ships beside the CLI entry, following existing parser/SQL helpers.

## Consequences

No model-facing capability, SDK fork, native add-on, account or install hook is added.
Each verification temporarily adds bridge processes and a local IPC endpoint. This is
process ownership, not a sandbox: the configured command is developer-selected, and
there is no containment claim for deliberate daemonization or a force-killed verifier.
Cleanup can extend wall-clock duration beyond a protocol timeout while it reaps children.

The public client configuration continues to name Lorepack, never a bridge endpoint or
nonce. Tests and the installed-artifact check must cover both probe and session, actual
read proof, wrappers, argument boundaries, pipe semantics and resource recovery on all
three supported operating systems. Human client trust prompts remain a separate check.
