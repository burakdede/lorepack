# Discovery and fingerprinting

The first two compiler stages: decide what belongs in a build, then decide whether it
changed.

## One matcher, three callers

Chokidar removed glob support in v4 and has not returned it, so the include and exclude
logic is ours. That makes one property essential: **the initial scan, the reconciliation
scan and watch-event filtering must all call the same matcher.** If they disagreed, a file
would appear or disappear depending on how it was noticed, and the resulting bug would
reproduce only under timing.

Patterns are gitignore-style, evaluated with picomatch:

- a pattern without a slash matches at any depth;
- a leading slash anchors it to the source root;
- a slash in the middle anchors it too, so `docs/*.md` is about one directory;
- a trailing slash restricts it to directories and everything beneath, and **does not**
  anchor it, so `build/` means "a directory called build, wherever it is";
- `!pattern` re-includes, and the last matching rule wins.

The always-on exclusions from architecture section 19.2 are applied first, then
`.loreignore`.

### Why the trailing slash is called out

It is the one rule that is easy to implement backwards, and doing so is quiet. Deciding
anchoring by looking for a separator in the raw pattern counts the trailing marker, which
turns every `foo/` rule into a root-only rule. That is how `node_modules/**`, `.git/**` and
four others came to apply at depth zero and nowhere else: correct on a flat folder, and
useless on a folder containing a subproject, where the first build walks the dependency tree
and `.git/config` becomes indexed context (#201).

Two consequences shaped the fix:

- **The defaults are written `foo/`, never `foo/**`.** The second form says something
  different, and the difference does not show up until someone nests a directory.
- **The test is a table of depths, not a list of names.** Each entry was correct at depth
  zero, which is the only depth anything asserted, so the list read as complete for four
  phases. `packages/compiler/test/discover.test.ts` now checks every default at three depths,
  and `packages/cli/test/init.test.ts` checks that the `.loreignore` written by `lore init`
  *behaves* the same as the enforced list rather than merely containing the same lines.

A project always has the last word: the defaults are the first rules in the list and
`.loreignore` comes after, so `!vendor/dist/notes.md` re-includes something a default removed.

## Every exclusion is reported

Section 6.9 requires an unsupported file to be excluded "with a visible warning and exact
path". Silently indexing nothing is indistinguishable from a broken build, so discovery
never drops a file quietly.

Warnings distinguish a **planned** format from an **unsupported** one. A user with a PDF
should read "supported in a later release", not "unsupported": those are materially
different statements, and only one of them is a reason to look for another tool.

### Unreadable bytes are decided while fingerprinting, not while parsing

An extension decides whether a parser exists. Only the content decides whether the file is
text at all, and a file can be binary, UTF-16 or invalid UTF-8 under any extension. That
verdict is reached in the fingerprinting stage, which already reads every byte to hash it,
and the file is excluded with an `undecodable-content` warning naming the path and the fix.

The stage matters. Excluding at parse time instead, which is what Lorepack did until #165,
put the file in the fingerprint but not in the build, so `lore status` reported the project
dirty forever and `lore build` then reported no changes: a loop of bad advice. Fingerprinting
is the last stage that can change what a build contains, so it is where the decision belongs.

The consequence is that section 6.9's other row, a supported file that fails to parse, is
unreachable for the parsers this phase ships: markdown and text cannot fail on decodable
input. The path stays in place for the formats in Phase 5, which can.

## Symlinks

Not followed by default; each one skipped produces a warning naming it.

When following is enabled, escaping is still refused. Discovery resolves the real path and
checks containment against that. This is the check `toCanonical` deliberately does not
make: it reasons about path strings, and a symlink pointing outside the project
canonicalizes perfectly cleanly. Only `realpath` catches it, which needs the filesystem,
which is why the check lives here.

The root is resolved too, since it may itself sit behind a link. On macOS `/tmp` is
`/private/tmp`, and comparing an unresolved root against a resolved target would reject
every file in a temp directory.

## Fingerprinting

**Content decides freshness. Metadata never does.** A file can change without its
modification time moving, and an mtime can move without the content changing. Size and
mtime are kept for diagnostics and for coalescing watch events, and that is all.

There is a test for the direction that actually bites: rewriting a file with identical
content moves its mtime, and the fingerprint must not move.

Hashing runs with bounded concurrency because it is IO bound, and the results are
reordered afterwards. A test asserts that concurrency 1 and concurrency 8 produce the same
fingerprint, so the value can never depend on which worker finished first.

## The cache key

Architecture section 12.3 names exactly what invalidates a parse:

```text
content hash + parser id and version + relevant configuration + rule inputs
```

Under-including means reusing a stale parse, which produces a wrong build. Over-including
means rebuilding for no reason, which produces a slow one. Both are defects, so the inputs
are an explicit type rather than a whole config object hashed for convenience: a field
cannot be added by accident, and each one has a test proving it invalidates.

## Scale envelope

From architecture section 5.4, enforced here rather than discovered later:

| Limit | Behaviour |
|---|---|
| 2,500 files | Refuses without `--allow-large-project` |
| 1 GB total | Warns, naming the largest artifacts |
| Per-artifact cap | Excludes that file with a warning |

The file-count refusal is a hard stop because it is the one users hit by accident, usually
by pointing Lorepack at a directory containing a dependency tree. The message says the
envelope is untested beyond that point rather than unsupported, which is the honest framing.
