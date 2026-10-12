# Current-only retrieval and context

## Status

Accepted.

## Context

The previous visibility rule returned archived and superseded matches when no eligible
current candidate matched. This made a default current task select historical bodies,
despite the user not requesting history. Default alternatives also delivered historical
text even when the selected set was current-only. The accepted v0.1 audit specifies a
deliberate product-policy correction, superseding that fallback.

## Decision

Default search and task context exclude archived and user-declared superseded candidates
regardless of whether current evidence exists. An empty qualifying set stays empty.
Default task bundles report historical omissions with locators but do not carry their
bodies as alternatives. Explicit includeArchived enables labeled historical selection
and alternatives. Add the same explicit flag to CLI export.

Drafts remain eligible and labeled. Authority and supersession stay declarations, not
truth decisions. Explicit source reads remain possible. Apply the policy in the shared
ranking/runtime boundary so local and remote transports cannot disagree.

## Consequences

Existing callers relying on automatic historical fallback now receive an empty selection
and must request history deliberately. Public response schemas and immutable build IDs
remain unchanged; this is an execution-policy change. Exact policy identity is tracked
separately in #693. Budget accounting for delivered alternatives remains #424.
