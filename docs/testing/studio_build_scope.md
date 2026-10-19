# Studio build scope verification

Studio's sidebar polls the active build every two seconds. Source inventory,
Stored text, warnings, table catalog, detail and query results use that build id
in both their cache keys and API requests. A changed pointer therefore starts
fresh reads, and an in-flight request still reads the build it was keyed for.
Copy as export sends the successful assembly request with the bundle's actual
build id, so edits to the form or later activation do not change what gets copied.

Manual checklist for a disposable project:

1. Open Sources, choose a document and note its Stored text and sidebar build id.
2. Change the document and run `lorepack build` outside Studio. Within the next
   sidebar poll, confirm the build id and Stored text change together. Compare
   the text with `GET /v1/sources/:artifactId?buildId=<shown-id>` and revisit
   Sources after navigating away.
3. Visit Excluded and Tables before and after another build. Confirm warnings,
   table rows and any query result belong to the displayed build.
4. Assemble a Playground bundle. Edit Task and Budget without assembling again,
   activate another build outside Studio, then Copy as export. Confirm its task,
   budget and build id still match the bundle on screen.
5. Cause an export failure and confirm the server's code, message and remediation
   appear beside Copy as export.

The Chromium regression in `tools/studio-e2e/test/build_scoped_inspection.spec.ts`
uses a real project, CLI build, server and clipboard. The component regressions
cover typed export errors and cache replacement for warnings and tables. On
19 October 2026, macOS arm64, Node 24.21.0 and pinned Playwright 1.62.1,
the two browser flows passed. The captured [Sources screenshot](../images/studio_build_scoped_source.png)
was inspected and shows the new build id alongside its revised Stored text.
