# Global tarball smoke

Issue #782 verifies the public smoke's command launch before publication. Build
first, then run:

```sh
pnpm build
node scripts/check-global-smoke.mjs --out /tmp/lorepack-global-evidence
```

This packs the current CLI with the existing frozen production closure, installs
that actual tarball globally into a disposable prefix with lifecycle scripts
ignored, and runs every stage of `public-registry-smoke.mjs`. The version and
installed `gitHead` must match the checkout. Prefix and project paths contain
spaces and shell punctuation. No checkout-entry override is allowed.

The verifier removes its global prefix and project, leaving the tarball, installed
manifest, source/tarball/script hashes, Node version, stdout, stderr and real exit
result in the evidence directory. A failure stays a failure. It does not retry or
suppress a launcher error.

The existing Public registry smoke workflow has a separate manual `tarball` mode
on macOS, Linux and Windows. Normal release and manual published-version runs
retain all registry, signature, provenance and public smoke checks. Local tarball
success is preparation; the public registry run still follows publication.

The original Windows implementation launches `.cmd` files without a command
interpreter. This branch initially retains it to collect the real native red
before selecting a correction. No successful native Windows result is claimed.
See the [Node batch-file contract](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
and [npm global layout](https://docs.npmjs.com/cli/v11/configuring-npm/folders/).
