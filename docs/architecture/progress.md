# Progress and diagnostics

Architecture section 4.3 forbids a command that appears to hang, and section 5.5 makes
"visible progress at least once per second" a release gate. Section 14.3 adds a hard
constraint: in `lore mcp`, stdout carries protocol bytes only.

Both fall out of one design: stages emit typed events, renderers subscribe.

```ts
const bus = new ProgressBus();
bus.subscribe((event) => renderer.handle(event));

bus.start('parsing', 'Parsing', artifacts.length);
for (const [i, artifact] of artifacts.entries()) {
  await parse(artifact);
  bus.progress('parsing', i + 1, { unit: 'documents' });
}
bus.finish('parsing', artifacts.length);
```

The compiler never writes to a console. That is what lets the same run drive a TTY, a CI
log, a test collector, and later the Studio, without the pipeline knowing.

## Measurable progress, not spinners

`stage-progress` requires a `completed` count. A spinner is not acceptable progress for
parsing or indexing, because it cannot distinguish slow work from a hang. The renderer
throttles to at most one update per `minUpdateIntervalMs` (default 1000), so a burst of
ten thousand events becomes a readable line per second.

## TTY and CI

| Mode | Behaviour |
|---|---|
| TTY | Rewrites the current line with `\r`, closes it when the stage finishes |
| Non-TTY | One plain line per update, no escape sequences, safe for CI logs |

Colour follows the ecosystem convention: `NO_COLOR` disables it outright, `FORCE_COLOR=0`
disables it even on a TTY, `FORCE_COLOR=1` enables it off one.

## stdout discipline

`lore mcp` constructs the renderer with `write: (text) => process.stderr.write(text)`.
Nothing else in the process may write to stdout. This is asserted by a test that runs the
server and parses stdout as pure protocol frames.
