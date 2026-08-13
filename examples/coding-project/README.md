# Coding Project Example

This example models the context a coding agent should read before changing a service.

## Walkthrough

```bash
pnpm build
node packages/cli/dist/entry.js --cwd examples/coding-project build
node packages/cli/dist/entry.js --cwd examples/coding-project search "rollback"
node packages/cli/dist/entry.js --cwd examples/coding-project export --task "How should the sync worker recover after a failed deploy?"
```

The `adr/**` rule gives architectural records the highest declared authority. Draft notes still
build, but they are labelled as drafts and do not outrank current notes.
