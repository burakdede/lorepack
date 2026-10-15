---
"@lorepack/cli": patch
---

Publish fully initialized state before concurrent first opens can read it, preserving the winning runtime identity and existing-state migration guards.
