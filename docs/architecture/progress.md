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

### Width

A progress line is truncated to the terminal width, leaving one column free. Without that,
a line wider than the terminal wraps, and the `\r` that rewrites it returns to the start of
the last physical row: the earlier row is stranded, and every update strands another. When
the row is too narrow to hold everything, the counts give way and the status stays, because
`done` and the elapsed time are what a reader is waiting for.

The width is passed in rather than read from `process`, so the behaviour is testable by
rendering to a writer with a known width instead of by eye.

### Colour

`NO_COLOR` disables it outright, `FORCE_COLOR=0` disables it even on a TTY, `FORCE_COLOR=1`
enables it off one, and `--no-color` overrides all three.

Resolved per stream, because the two are redirected separately: `lore build > log.txt` on a
terminal keeps its errors readable, and `lore build 2> log.txt` puts no escapes in the file.

Only three things are ever coloured: the status word of a finished stage, `error:`, and
`next:`. Each carries meaning a reader uses. `--json` output never carries an escape, which
is asserted rather than assumed.

## stdout discipline

`lore mcp` constructs the renderer with `write: (text) => process.stderr.write(text)`.
Nothing else in the process may write to stdout. This is asserted by a test that runs the
server and parses stdout as pure protocol frames.
