# Allow delayed Windows memory observer startup

## Status

Accepted on 2026-10-21 for issue #801. This supersedes the Windows startup
deadline in ADR 0046 only.

## Context

Three Windows CI jobs failed before the PowerShell memory reader emitted its
first script marker. The reader had spawned and remained alive, but emitted no
identity or RSS sample by 5000 ms. The failures occurred in verify,
clean-install and benchmark contexts. The exact runner scheduling or PowerShell
initialization cause is unknown. Isolation waits for both parser readiness and
the first memory sample before sending source bytes to the parser.

## Decision

Allow at most 15000 ms for the Windows observer's first sample. Keep the 100 ms
sampling cadence, 250 ms report deadline, output caps, RSS threshold and
fail-closed behavior unchanged. Preserve the parser input barrier until that
first valid sample arrives.

## Consequences

Hosted Windows startup delays up to 15 seconds no longer fail parsing solely
because PowerShell did not start reporting within five seconds. A missing or
invalid initial report still stops the parser before it receives source data.
If PowerShell is unavailable, the error can take up to ten seconds longer to
surface. The bound should be revisited if later native evidence identifies a
different source of startup delay.
