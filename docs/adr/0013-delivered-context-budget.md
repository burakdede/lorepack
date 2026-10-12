# Budget complete delivered context

## Status

Accepted, 2026-10-12. Issue #424, audit F07.

## Context

The old estimate counted selected passage text but excluded alternatives, locators,
diagnostics and framing. CLI JSON, HTTP, Markdown and duplicate MCP representations
all exceeded a 4,000-token request on the same compiled 70-document corpus.

## Decision

Fit identical whole evidence units against the largest complete supported representation.
Share Markdown rendering and MCP result construction with the portable runtime so actual
adapter output and accounting use the same code. Measure pretty CLI JSON with newline,
compact HTTP JSON, the complete MCP tool result and Markdown with the maximum configured
project-name length. Transport routing and client-owned prompts are outside this boundary.

Estimate `max(ceil(UTF-8 bytes / 3.6), whitespace word count)`, including the estimate's own
digits, and independently cap every representation at 4 MiB. Record the estimator parameters,
serialization versions, diagnostic limit and hard ceiling in execution policy identity.
Stored per-item estimates remain compiler provenance, not the delivered-output total.

Keep exact omission totals and reason counts while shortening diagnostic detail explicitly.
Remove whole units from the lowest-priority end after reducing diagnostic detail. Refuse
mandatory framing that cannot fit, including with an unsupported-budget override.

## Consequences

Selection is portable across adapters, at the cost of fitting the most expensive supported
representation, usually MCP. Smaller outputs can have unused capacity. Diagnostic entries
may be incomplete, but totals and truncation are explicit. Passage text is never clipped.
The estimate is a deterministic engineering contract, not a provider-tokenizer guarantee.
Execution identity changes while immutable content build IDs remain unchanged.
