# benchmarks

Versioned benchmark suites and their reference-machine metadata. Release gates live in architecture section 5.5.

Envelope build measurements live under `benchmarks/envelope/`.

- `reference-2026-08-05.json` measures the 2,500-file shape with 39,010 chunks. It is the run
  that exposed #245: incremental rebuilds are slower than the original sub-2 s envelope gate.
- `byte-envelope-2026-08-14.json` measures 2,500 files and 1.005 GiB of source text. It exceeds
  the byte envelope, but also produces 387,110 chunks, so use it for byte stress and not as a
  retrieval-envelope substitute.

The #245 decision is documented in `docs/architecture/build-orchestration.md`: v0.1 keeps
immutable build sealing, narrows the sub-2 s incremental rebuild claim to the lifecycle
benchmark corpus, and reports envelope rebuild latency instead of advertising an unmet number.
