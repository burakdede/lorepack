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

The original implementation failed the real Windows run with
`spawnSync npm.cmd EINVAL` after its global tarball installed. Source
`ae6efe83fc7df451290f81beaf58b7173de51169`, job `117335169765`, is the retained
native red; its Linux and macOS controls passed.

Windows global-root discovery now runs the configured Node installation's
bundled npm JavaScript entry. CLI stages run that same Node executable with the
actual global package's declared entry, after version and entry-path validation.
This preserves literal paths and arguments without a command interpreter. A
missing npm installation or package entry fails explicitly. The existing local
entry override remains available to its original callers; this verifier removes
it so it always tests the real global package.

See the [Node batch-file contract](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows),
[Node's bundled Windows npm launcher](https://github.com/nodejs/node/blob/v24.21.0/deps/npm/bin/npm.cmd)
and [npm global layout](https://docs.npmjs.com/cli/v11/configuring-npm/folders/).
