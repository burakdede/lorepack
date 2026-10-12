---
'@lorepack/cli': patch
---

Require manifest and catalog members when verifying an archive, and refuse
nonregular payload entries before reading them or skipping directory records.
Retain complete identity inputs in newly sealed builds for independent verification.
Recompute catalog roots, declared rules, typed rows and build identity; require
complete content-addressed objects and compatible schemas. Report integrity only
and an unsigned publisher. Older packages missing identity inputs are explicitly
unsupported. Catalog checks run read-only in a bounded private child process.
