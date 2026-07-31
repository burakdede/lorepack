# Contributing to Lorepack

Thanks for your interest. This project is pre-v0.1 and moving fast.

## Read this first

**[`AGENTS.md`](AGENTS.md) is the authoritative working agreement** — for humans and for
coding agents alike. It covers the design direction and its non-negotiable invariants,
what is deliberately out of scope, how work is tracked, the session handoff protocol,
commit and PR conventions, and the testing bar. This file only covers the mechanics it
does not.

## Work is tracked before it is written

Every change starts as a task in the [backlog](https://github.com/users/burakdede/projects/8).
If what you want to do isn't there, open an issue first — with acceptance criteria and a
test plan — so the design conversation happens before the code.

Read the issue's full comment history before starting: each task carries its own session
handoff log, and the most recent comment is the current state of that work.

## Development

Requires Node.js `>=24.15 <25` and pnpm. No Python, compiler toolchain or Docker — if you
ever need one to build this project, that is a bug.

```bash
pnpm install
pnpm lint          # Biome
pnpm format:check
pnpm typecheck
pnpm test          # Vitest
pnpm build
```

*(The toolchain lands with the monorepo scaffold; until then these commands are the target,
not the current state.)*

## Submitting a change

1. Branch from an up-to-date `main`: `git fetch && git rebase origin/main`.
2. Keep commits small and cohesive — each one compiles and passes tests on its own.
3. Write a short imperative commit subject (≤72 chars); add a body only when the *why*
   isn't obvious. **No AI attribution of any kind** in commits, PR titles, PR bodies or
   branch names.
4. Include tests. A change without tests is unverified — see the testing section of
   `AGENTS.md` for which levels apply.
5. Update documentation in the same PR.
6. Open a PR linking its issue, stating what you verified. Rebase again before pushing.

## Reporting bugs

Use the issue templates. Bug reports need your platform, Node version, and (once it
exists) `lore doctor --json` output — without those, most reports are unreproducible.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
