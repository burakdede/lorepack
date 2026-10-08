# Package boundaries

Lorepack is modular in the repository, but the first public release has one npm package.

## Public package

| Package | Public role | User entry point |
|---|---|---|
| `@lorepack/cli` | Complete local Lorepack product: project setup, deterministic builds, inspection, serving, MCP connection and deployment commands | `npm install -g @lorepack/cli`, then `lorepack` |

The CLI build bundles the internal Lorepack packages into its published `dist/` entry point.
Its tarball also carries the SQL migrations and Studio assets required by an installed CLI.
Users should not need to install or import the internal packages separately.

## Internal packages

These packages remain separate because their boundaries are architectural, not because they are
currently independent products.

| Package | Responsibility | Why the boundary matters |
|---|---|---|
| `@lorepack/core` | Domain types, schemas, errors, paths, identifiers and narrow ports | Keeps storage, parsers, protocols and deployment targets out of the domain layer |
| `@lorepack/parsers` | Markdown, text, HTML, PDF, DOCX, CSV and XLSX parsing | Keeps format-specific code away from the compiler and runtime |
| `@lorepack/compiler` | Discovery, parsing orchestration, chunking, validation and build sealing | Makes deterministic compilation independently testable |
| `@lorepack/backend-local` | SQLite state, sealed build catalogs, object storage and local locks | Contains Node and SQLite concerns behind storage ports |
| `@lorepack/runtime` | Read-only runtime capabilities and HTTP routes | Allows the same runtime contract to serve local and remote projections |
| `@lorepack/mcp` | MCP tools, resources and transports | Isolates protocol changes from the build and storage layers |
| `@lorepack/connect-clients` | Detection and safe configuration edits for supported AI clients | Keeps client-specific configuration formats out of the CLI core |
| `@lorepack/deploy-cloudflare` | Cloudflare projection, verification and activation | Keeps target-specific deployment logic out of compilation |
| `@lorepack/sdk` | Typed HTTP client for a Lorepack runtime | Reserved for a later public API once the remote contract is stable |

The internal packages are private workspace packages in the first release. They can become
public later when a package has a documented audience, a stable API, independent compatibility
policy and a reason for users to depend on it directly.

## Release rule

Release discovery uses `private: false`, so only `@lorepack/cli` is preflighted, packed and
published to npm today. Adding a public package requires changing its privacy, documenting its
public contract here, adding package-level release notes and adding registry smoke coverage.
