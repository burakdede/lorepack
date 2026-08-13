# Lorepack docs

Start here, then take the one-hop path that matches the job.

| Job | Start |
|---|---|
| Install and try Lorepack | [`../README.md`](../README.md) |
| Run the two-command quick start | [`../README.md#the-two-commands`](../README.md#the-two-commands) |
| Understand the build lifecycle | [`architecture/README.md`](architecture/README.md) |
| Connect an AI client or deployment target | [`integrations/`](integrations/) |
| Check supported platforms and limits | [`compatibility/README.md`](compatibility/README.md) |
| Look up every command and flag | [`cli-reference.md`](cli-reference.md) |
| Contribute or pick up a backlog task | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Inspect the package format | [`package-format/README.md`](package-format/README.md) |

Generated and checked docs:

- [`testing/acceptance.md`](testing/acceptance.md) is generated from the acceptance scenarios.
- [`cli-reference.md`](cli-reference.md) is generated from the CLI command definitions.
- [`images/`](images/) contains generated pictures captured from real CLI and Studio output.

## The pictures are generated, not pasted

`scripts/capture-docs.mjs` builds a demo project, runs the real commands, starts a real
`lore dev`, and photographs Studio in the browser. Nothing under `docs/images/` is taken by
hand.

```bash
pnpm exec playwright install chromium   # once
pnpm docs:capture
```

This is not tidiness. A screenshot nobody can regenerate is wrong on the first interface edit
and stays wrong, and by then deleting it is easier than retaking it. Making it cheap to retake
is what keeps the documentation honest.

Terminal output is rendered to SVG rather than recorded as a GIF, for two reasons. A GIF needs
a recorder and an encoder, which is a toolchain this project does not have and invariant 7
does not want. And an SVG of real captured bytes stays legible at any size and diffs as text,
so a review can see what the output actually became.
