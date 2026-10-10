# SQLite FTS5 availability

Lorepack's entire v0.1 retrieval path is SQLite FTS5 (architecture sections 8.3 and 12.9).
If the Node build in use has no FTS5 module, Lorepack cannot work, so it refuses at
startup with a fix rather than surfacing later as an empty search.

## Minimum SQLite version: 3.53.2

Lorepack refuses to run on SQLite older than **3.53.2**. Earlier releases carry two FTS5
memory-corruption bugs that an FTS5 `MATCH` against a database with crafted FTS5 pages
triggers: a heap buffer overflow write in `fts5ChunkIterate()` and an out-of-bounds read in
`fts5LeafSeek()` (CVSS 4.0 8.5).

- [CVE-2026-11822](https://osv.dev/vulnerability/CVE-2026-11822)
- [CVE-2026-11824](https://osv.dev/vulnerability/CVE-2026-11824)
- Fix release: [SQLite 3.53.2](https://sqlite.org/releaselog/3_53_2.html)

Every Lorepack search is an FTS5 `MATCH` over `context.sqlite`. That database is normally
built on the same machine, but it becomes attacker-controlled when a `.lore/` directory is
committed to or copied into a repository, or synced through a shared folder. Lorepack does not
run the FTS5 integrity check before serving, so the SQLite version is the control.

Two checks enforce it, because the Node version alone cannot prove the SQLite version:

1. **The Node floor, `>=24.19.0 <25`.** Node 24.19.0 (2026-08-03) is the first 24.x release
   whose bundled SQLite is fixed: it ships 3.53.3, and 24.20.0 and 24.21.0 ship 3.53.4
   (`deps/sqlite/sqlite3.h` at each tag). 24.18.1 bundles 3.53.1 and is refused.
2. **The SQLite floor, checked at startup and by `lorepack doctor`.** A Node linked against a
   shared system SQLite reports that library, whatever its age. The CLI reads
   `sqlite_version()` before loading any command and exits 3 with
   `LORE_E_UNSUPPORTED_SQLITE` below 3.53.2. `lorepack doctor` reports the same thing as the
   `sqlite-version` check, with the detected version, the minimum and the `execPath`.

```text
This Node uses SQLite 3.53.1, but Lorepack requires SQLite 3.53.2 or newer.
Earlier releases carry FTS5 memory corruption (CVE-2026-11822, CVE-2026-11824) that a crafted build database can trigger through search.

Install an official Node build, which bundles SQLite 3.53.2 or newer from Node 24.19.0:
  https://nodejs.org/en/download
  or: nvm install 24 | fnm use 24 | mise use node@24
A Node linked against a shared system SQLite carries that system SQLite instead.
Advisories: https://osv.dev/vulnerability/CVE-2026-11822 https://osv.dev/vulnerability/CVE-2026-11824
See docs/compatibility/sqlite-fts5.md
  code: LORE_E_UNSUPPORTED_SQLITE
```

`LORE_SKIP_ENGINE_CHECK=1` bypasses both checks with a warning. It exists for diagnosing an
unsupported runtime, not for running one.

## Why this page exists

Node's bundled SQLite compiles `SQLITE_ENABLE_FTS5`. It landed in
[nodejs/node#57621](https://github.com/nodejs/node/pull/57621) ("sqlite: enable common
flags", merged 2025-04-04), which also enabled FTS3, RTREE, GEOPOLY, MATH_FUNCTIONS,
SESSION, PREUPDATE_HOOK, DBSTAT_VTAB, COLUMN_METADATA and PERCENTILE. Every Node 24
release therefore has it.

Search results still surface older reports saying `node:sqlite` lacks FTS5. Those predate
that pull request. They are stale, not wrong-at-the-time.

The residual risk is builds linked against a *shared* system SQLite rather than the
bundled copy. Those are not hypothetical in general, so the runtime probe stays mandatory,
but see the measurements below for how the risk looks in practice today.

## Verified builds

Measured with `pnpm probe:fts5`. Every row is a real run, not an inference. Rows dated
2026-07-31 predate the 3.53.2 floor and are kept as FTS5 evidence: their SQLite is below it.

| Build | Node | SQLite | FTS5 | Notes |
|---|---|---|---|---|
| nodejs.org official, darwin-arm64 (via mise), 2026-10-10 | 24.21.0 | 3.53.4 | yes | The supported configuration, pinned in `mise.toml` |
| nodejs.org official, darwin-arm64 (via mise), 2026-10-10 | 24.19.0 | 3.53.3 | yes | The floor |
| nodejs.org official, darwin-arm64 (via mise), 2026-10-10 | 24.18.1 | 3.53.1 | yes | Below the SQLite floor, refused |
| nodejs.org official, linux-x64 (via mise) | 24.18.1 | 3.53.1 | yes | Below the SQLite floor |
| nodejs.org official, linux-x64 (via mise) | 24.14.1 | 3.51.2 | yes | Below our floor for other reasons, see below |
| Docker `node:24` (Debian bookworm) | 24.18.1 | 3.53.1 | yes | |
| Docker `node:24-slim` | 24.18.1 | 3.53.1 | yes | |
| Docker `node:24-alpine` (musl) | 24.18.1 | 3.53.1 | yes | |
| Debian trixie `apt install nodejs` | 20.19.2 | n/a | n/a | Distro ships Node 20, below the supported range |
| Fedora latest `dnf install nodejs` | 22.23.1 | 3.51.2 | yes | Distro ships Node 22, below the supported range |
| GitHub Actions `actions/setup-node`, ubuntu, windows, macos | 24.21.0 | | yes | FTS5 and the SQLite floor asserted by the CI probe job on every run |

Not yet measured: Homebrew, Windows package managers (winget, Chocolatey), Nix, and
enterprise-repackaged builds. Contributions welcome; run `pnpm probe:fts5` and open a pull
request adding a row.

### What the measurements show

Two findings worth stating plainly.

1. **No build tested lacks FTS5**, including the musl and shared-library-friendly ones.
2. **The distributions that package Node do not yet package a version Lorepack supports.**
   Debian trixie ships 20.19.2 and Fedora ships 22.23.1, both below the `>=24.19.0 <25`
   floor. So the "distro build might lack FTS5" scenario cannot currently arise on a
   supported configuration: those builds fail the engine guard first, for an unrelated
   and more basic reason.

That lowers the assessed risk but does not remove it. Distributions will ship Node 24
eventually, and custom or enterprise builds can link a shared SQLite at any time. The
probe costs microseconds and turns a confusing failure into an actionable one, so it stays.

## What Lorepack does about it

At startup and in `lorepack doctor`, a probe creates an FTS5 table, inserts, matches, and drops
it. It is a capability check, not a version check, because the version string cannot tell
you how a build was compiled.

On failure the error names the detected SQLite version, the Node version, and the
`execPath` of the interpreter, then points at an official build. The `execPath` matters:
the usual cause is running a different Node than expected, and seeing the path is what
makes that obvious.

```text
error: This Node build has SQLite 3.44.0 without FTS5, so lexical search cannot work.
  code: LORE_E_FTS5_UNAVAILABLE

next: Install an official Node build, which compiles FTS5:
  https://nodejs.org/en/download
  or: nvm install 24 | fnm use 24 | mise use node@24
A Node linked against a shared system SQLite may omit it.
See docs/compatibility/sqlite-fts5.md
```

There is no fallback path. A non-FTS5 search would silently return worse results, which is
worse than refusing.

## Reproducing

```bash
pnpm probe:fts5                       # this machine
docker run --rm node:24-alpine node -e "$(cat scripts/probe-fts5.mjs)"
```

The probe exits non-zero when FTS5 is missing or SQLite is below 3.53.2, so it works as a CI gate as well as a
diagnostic.
