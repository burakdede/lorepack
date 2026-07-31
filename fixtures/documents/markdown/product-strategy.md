---
title: Product Strategy
owner: platform
status_note: this is metadata, not a Lorepack rule
---

# Product Strategy

The wedge is the lifecycle, not retrieval.

## Positioning

Lorepack is a versioned context build system.

- Build once
- Version every change
- Roll back instantly

### Non-goals

Not a chatbot. Not a vector database.

## Implementation

```ts
export function build(project: Project): Build {
    return seal(compile(project));
}
```

| Stage | Owner |
| --- | --- |
| compile | compiler |
| serve | runtime |
