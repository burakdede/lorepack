# The `lore` command line

One shell, many commands. Every command is a handler; argument parsing, error rendering,
exit codes and output modes belong to the shell so no command reinvents them.

## Entry point

`packages/cli/src/bin/lore.ts` does one thing before anything else:

```ts
import { assertSupportedNode } from '@lorepack/core/engine';
assertSupportedNode();
const { runCli } = await import('../framework/program.js');
```

The import ordering is load-bearing. `@lorepack/core/engine` is a subpath export with no
transitive imports beyond node builtins, so on an unsupported runtime the user gets one
actionable line rather than a module-load failure from inside a dependency. Everything
else loads dynamically, after the check. A test asserts that the only static import in
that file is the guard.

## Writing a command

```ts
{
  name: 'status',
  description: 'Show source dirtiness and the active build.',
  flags: [{ flags: '--exit-code', description: 'exit non-zero when dirty' }],
  handler: async (args, flags, context) => {
    context.progress.start('fingerprinting', 'Fingerprinting');
    // ...
    return { human: renderStatus(state), json: state };
  },
}
```

A handler returns a result or throws. It never calls `process.exit`, never formats an
error, and never writes to a stream directly for output that has a structured equivalent.
Returning `undefined` means the command produced its own output and has no structured
result.

Commands are registered explicitly in `commands/index.ts`. No dynamic discovery:
architecture section 4.8 applies here too, and an explicit list is what makes `lore --help`
reviewable in a pull request.

## Global options

| Flag | Effect |
|---|---|
| `--json` | The structured result on stdout, nothing else |
| `--verbose` | Stage detail and debug diagnostics |
| `--no-color` | Disable colour, as do `NO_COLOR` and `FORCE_COLOR=0` |
| `--cwd <path>` | Run against a project elsewhere, without changing `process.cwd()` |

`--cwd` not mutating the process directory is deliberate: tests run commands in parallel
against different temp projects, and a global mutation would make that flaky.

## Output contract

With `--json`, **stdout carries the structured result and nothing else**. Progress,
warnings and human text move to stderr. That is what makes `lore plan --json | jq` work,
and it is the same discipline `lore mcp` needs in Phase 2, where stdout carries protocol
frames. The renderer's write target is injected rather than assumed, so the MCP server
passes stderr without any other change.

## Errors and exit codes

Every failure funnels through one handler. A `LoreError` renders with its remediation and
exits with `exitCodeFor(code)`; anything unexpected becomes `LORE_E_INTERNAL`. Argument
failures from commander are converted into `LORE_E_INVALID_ARGUMENT`, so a user sees one
error format and a script sees one set of exit codes.

Two details worth keeping:

- Commander writes its own error before throwing, so `outputError` is suppressed. Without
  that, every argument error printed twice.
- When no subcommands are registered, commander reports an unknown command as
  `excessArguments`. Both codes map to the same typed error.

See `docs/architecture/errors.md` for the exit-code table.
