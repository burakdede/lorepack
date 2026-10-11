---
'@lorepack/cli': patch
---

Require manifest and catalog members when verifying an archive, and refuse
nonregular payload entries before reading them or skipping directory records.
Retain complete identity inputs in newly sealed builds for independent verification.
