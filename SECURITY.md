# Security Policy

## Supported versions

Lorepack is pre-v0.1. There is no released version and therefore no supported version
yet. Once v0.1 ships, this section will state exactly which releases receive fixes.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through
[GitHub Security Advisories](https://github.com/burakdede/lorepack/security/advisories/new),
or by email to **burak@burakdede.com**.

Please include: what the issue is, how to reproduce it, the impact you believe it has,
and your platform and Node version. A proof of concept is welcome but not required.

You can expect an acknowledgement within a few days and an assessment of whether the
report is accepted, with an indication of timeline. Reporters are credited in the advisory
unless they prefer otherwise.

## Where the risk lives

Areas most relevant to security reports, so you know what is in scope:

- **Parsers** — Lorepack reads untrusted documents (PDF, DOCX, XLSX, CSV, HTML). Crashes,
  unbounded memory, or escapes from parsing are in scope.
- **The read-only SQL surface** — model-facing table queries are constrained to a single
  `SELECT`, enforced by an AST allowlist, a SQLite authorizer, and a worker-thread
  deadline. Any bypass is in scope.
- **Filesystem boundaries** — path traversal or symlink escape outside a configured source
  root.
- **Model-facing tools** — every MCP tool is read-only by design. A tool that can write,
  build, deploy, edit sources or execute a command is a vulnerability.
- **Secret handling** — secrets must never reach a build manifest, log, error message or
  protocol response.
- **Remote deployments** — authentication bypass, or candidate build data being reachable
  before activation.

## What is not a vulnerability

- Lorepack's secret-shaped-file warning is a guardrail, not a secret scanner; missed
  secrets in source files are not a vulnerability in Lorepack.
- `authority`/`status`/`supersedes` are user-declared ranking hints. Retrieval returning a
  document you consider wrong is a ranking issue, not a security one.
