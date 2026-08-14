# benchmarks

Versioned benchmark suites and their reference-machine metadata. Release gates live in architecture section 5.5.

The v0.1 release summary is `benchmarks/releases/v0.1.json`, with the human-readable report in
`docs/compatibility/performance-v0.1.md`.

## Reference machines

The primary v0.1 numeric gates use the Linux development reference machine captured in the
committed benchmark artifacts: AMD Ryzen 9 3900X 12-Core Processor, 24 cores, 31 GB RAM, Linux
x64, Node.js 24.18.1, local SSD class storage. The historical JSON did not capture the exact
storage device, so future release-candidate runs must record the device model or hosted instance
type.

The true byte-envelope stress run uses a supplemental Darwin arm64 machine: Apple M1 Pro, 10
cores, 32 GB RAM, local APFS SSD, Node.js 24.18.1.

Envelope build measurements live under `benchmarks/envelope/`.

- `reference-2026-08-05.json` measures the 2,500-file shape with 39,010 chunks. It is the run
  that exposed #245: incremental rebuilds are slower than the original sub-2 s envelope gate.
- `byte-envelope-2026-08-14.json` measures 2,500 files and 1.005 GiB of source text. It exceeds
  the byte envelope, but also produces 387,110 chunks, so use it for byte stress and not as a
  retrieval-envelope substitute.

The #245 decision is documented in `docs/architecture/build-orchestration.md`: v0.1 keeps
immutable build sealing, narrows the sub-2 s incremental rebuild claim to the lifecycle
benchmark corpus, and reports envelope rebuild latency instead of advertising an unmet number.
