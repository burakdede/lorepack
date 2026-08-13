# Product Research Example

This example is a small product research corpus with current notes, archived notes and a
spreadsheet-like CSV table.

## Walkthrough

```bash
pnpm build
node packages/cli/dist/entry.js --cwd examples/product-research plan
node packages/cli/dist/entry.js --cwd examples/product-research build
node packages/cli/dist/entry.js --cwd examples/product-research inspect build
node packages/cli/dist/entry.js --cwd examples/product-research export --task "What should the launch page say?"
```

The rules in [`lore.yaml`](lore.yaml) declare that `archive/**` is archived and that
`research/current/positioning.md` supersedes the old positioning memo. Lorepack does not decide
which document is correct; it applies the precedence you declared.

The CSV under `sources/data/` becomes a typed table. Query it after building:

```bash
node packages/cli/dist/entry.js --cwd examples/product-research inspect tables
```
