# Contributing to Lorepack

Thanks for your interest. This project is pre-v0.1 and moving fast.

## Read this first

**[`AGENTS.md`](AGENTS.md) is the authoritative working agreement** for humans and for
coding agents alike. It covers the design direction and its non-negotiable invariants,
what is deliberately out of scope, how work is tracked, the session handoff protocol,
commit and PR conventions, and the testing bar. This file only covers the mechanics it
does not.

## Work is tracked before it is written

Every change starts as a task in the [backlog](https://github.com/users/burakdede/projects/8).
If what you want to do isn't there, open an issue first, with acceptance criteria and a
test plan, so the design conversation happens before the code.

Read the issue's full comment history before starting: each task carries its own session
handoff log, and the most recent comment is the current state of that work.

## Development

Requires Node.js `>=24.15 <25` and pnpm. No Python, compiler toolchain or Docker. If you
ever need one to build this project, that is a bug.

```bash
pnpm install
pnpm lint          # Biome
pnpm format:check
pnpm typecheck
pnpm test          # Vitest, the fast suite
pnpm build
pnpm acceptance    # the scenarios a person runs, against the real binary
```

*(The toolchain lands with the monorepo scaffold; until then these commands are the target,
not the current state.)*

## Submitting a change

1. Branch from an up-to-date `main`: `git fetch && git rebase origin/main`.
2. Keep commits small and cohesive. Each one compiles and passes tests on its own.
3. Write a short imperative commit subject (≤72 chars); add a body only when the *why*
   isn't obvious. **No AI attribution of any kind** in commits, PR titles, PR bodies or
   branch names.
4. Include tests. A change without tests is unverified. See the testing section of
   `AGENTS.md` for which levels apply.
5. **Add an acceptance scenario when your change alters what a person sees**: a new command
   or flag, different output, a new failure mode, or a guarantee stated in prose. Add a row
   to `tools/acceptance/src/scenarios/`, run `pnpm acceptance:docs`, and commit the
   regenerated `docs/testing/acceptance.md`. Internal refactors do not need one. If a
   scenario cannot be automated honestly, add it with `mode: 'manual'` rather than leaving
   it out; the checklist is the only place it can be seen.
6. Update documentation in the same PR.
7. Open a PR linking its issue, stating what you verified. Rebase again before pushing.

## Reporting bugs

Use the issue templates. Bug reports need your platform, Node version, and (once it
exists) `lore doctor --json` output. Without those, most reports are unreproducible.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
