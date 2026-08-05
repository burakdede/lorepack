import type { Scenario } from '../types.js';

/**
 * Milestone 2's exit criterion, driven end to end.
 *
 * Architecture section 21: **a real mixed project folder produces useful bounded context with
 * reliable provenance and spreadsheet queries.** These scenarios take that sentence apart and
 * assert each clause against a folder containing one file of every supported format.
 *
 * They are deliberately not unit tests with more files. Every parser already has golden
 * fixtures, and the Phase 4 audit is explicit about what those miss: a fixture written by
 * whoever wrote the parser cannot find what the parser forgot. What these add is the whole
 * pipeline, from bytes on disk to a citation a person can check.
 */
export const MIXED_SCENARIOS: readonly Scenario[] = [
  {
    id: 'mixed/every-format-contributes-with-its-own-provenance',
    title:
      'A folder of documents, spreadsheets and a PDF builds, and each cites its own kind of place',
    proves: 'Section 21 and invariant 5: mixed input, and a locator that fits the format.',
    mode: 'auto',
    fixture: { mixed: true, setup: ['init'] },
    steps: [
      {
        action: 'run',
        args: ['build'],
        json: true,
        expect: {
          exitCode: 0,
          json: [
            // Eight files, eight artifacts. A format that silently failed to parse would
            // show up here as a smaller number rather than as a passing test.
            { path: 'counts.artifacts', equals: 8 },
            // Two tables, from the CSV and the spreadsheet, with their rows imported.
            { path: 'counts.tables', equals: 2 },
            { path: 'counts.tableRows', equals: 6 },
          ],
        },
      },
      {
        action: 'run',
        args: ['inspect', 'sources'],
        json: true,
        describe: 'Every format reached a parser, and each one says which parser read it',
        expect: {
          exitCode: 0,
          // Named individually rather than counted, because a count is satisfied by eight
          // Markdown files and this is the assertion that the *formats* were read.
          stdout: { contains: ['runbook.md', 'policy.html', 'contract.pdf', 'onboarding.docx'] },
        },
      },
      {
        action: 'run',
        args: ['search', 'escalation'],
        json: true,
        describe: 'A phrase that appears only on the second page of the PDF is found',
        expect: {
          exitCode: 0,
          json: [
            { path: 'hits[0].locator.relativePath', matches: 'contract\\.pdf' },
            // The page reaches the reader as a heading, which is how the parser records it.
            //
            // `locator.page` is what should be asserted here and is **not**, because nothing
            // populates it: the parser records the page, `chunks` has no column for it, and
            // the hit arrives with `lineStart: 1` where the page belongs. That is #241, and
            // this line becomes `{ path: 'hits[0].locator.page', exists: true }` when it is
            // fixed. Asserting the line number instead would enshrine the defect.
            { path: 'hits[0].locator.headingPath[0]', equals: 'Page 2' },
          ],
        },
      },
      {
        action: 'run',
        args: ['search', 'repository access'],
        json: true,
        describe: 'And a phrase that appears only in the DOCX',
        expect: {
          exitCode: 0,
          json: [{ path: 'hits[0].locator.relativePath', matches: 'onboarding\\.docx' }],
        },
      },
    ],
  },

  {
    id: 'mixed/a-task-bundle-cites-a-document-and-a-table',
    title: 'A task that needs both prose and numbers gets both, each with its source',
    proves: 'Section 21: useful bounded context over a mixed folder, not over one format.',
    mode: 'auto',
    fixture: { mixed: true, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['export', '--task', 'what is the paging tier for the production environment'],
        json: true,
        describe: 'The runbook says the tiers live in the spreadsheet, so the answer needs both',
        expect: {
          exitCode: 0,
          json: [
            // Every selected passage carries a locator. Invariant 5 as an assertion rather
            // than an intention, and checked on the *first* one so an empty bundle cannot
            // pass it.
            { path: 'selected[0].locator.relativePath', exists: true },
            // Bounded, always. The schema refuses a bundle over its budget, so this asserts
            // the budget is real rather than absent.
            { path: 'budget', atLeast: 1 },
            { path: 'estimatedTokens', atLeast: 1 },
          ],
          // A document and a spreadsheet, both cited in one bundle. That is the mixed-context
          // claim, stated as two paths a reader can check rather than as a count that any two
          // Markdown files would satisfy.
          stdout: { contains: ['environments.xlsx', 'runbook.md'] },
        },
      },
    ],
  },

  {
    id: 'mixed/a-spreadsheet-can-be-queried-and-says-which-cells-it-came-from',
    title: 'A table query returns rows, and the answer names the sheet and the cell range',
    proves: 'Section 21 and section 10.8: a queried row traces back to a sheet and a range.',
    mode: 'auto',
    fixture: { mixed: true, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['inspect', 'tables'],
        describe: 'Both the CSV and the spreadsheet became tables',
        expect: { exitCode: 0, stdout: { contains: ['Environments', 'pricing'] } },
      },
      {
        action: 'run',
        args: ['inspect', 'tables', 'data/environments.xlsx'],
        json: true,
        describe: 'And the description carries the range, the statistics and the query names',
        expect: {
          exitCode: 0,
          json: [
            // The cell range, which is the provenance a spreadsheet owes and which was
            // dropped between the parser and the port until #235.
            { path: 'table.locator.cellRange', equals: 'A1:D4' },
            { path: 'table.locator.sheet', equals: 'Environments' },
            // The generated name, which is the only name a query may use.
            { path: 'table.sqlName', matches: '^t_environments_' },
            { path: 'table.columns[3].sqlName', matches: '^c_3_' },
            // Statistics reach a reader, rather than being computed and discarded.
            { path: 'table.columns[3].statistics.nullCount', equals: 0 },
            { path: 'table.columns[3].statistics.min', equals: 96.2 },
            { path: 'table.columns[3].statistics.max', equals: 4210.5 },
          ],
        },
      },
    ],
  },

  {
    id: 'mixed/all-three-clients-connect-without-hand-editing',
    title: 'Claude Code, Codex and VS Code are each planned and connected, with no manual edit',
    proves: 'Section 21: all supported clients connect without hand-editing configuration.',
    mode: 'auto',
    fixture: { mixed: true, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['connect', 'all', '--dry-run'],
        describe: 'The plan reports every supported client before anything is written',
        expect: {
          exitCode: 0,
          // Named individually: a count of three is satisfied by the same client three times.
          // Reported whether or not the client is installed, because "not installed" is an
          // answer to "can I connect this" and silence is not.
          stdout: { contains: ['Claude Code', 'Codex', 'VS Code'] },
        },
      },
      {
        action: 'run',
        args: ['connect', 'all', '--dry-run'],
        describe: 'And a dry run writes nothing, which is the promise that makes it safe',
        expect: { exitCode: 0, stdout: { excludes: ['Wrote', 'Backed up'] } },
      },
    ],
  },

  {
    id: 'mixed/a-table-past-its-column-limit-costs-only-that-table',
    title: 'A spreadsheet wider than the supported limit is left out, and the build succeeds',
    proves: 'Section 5.4: a scale limit bounds one artifact, never the whole project.',
    mode: 'auto',
    regression: 242,
    fixture: {
      files: {
        'docs/runbook.md': '# Runbook\n\nRolling back points at the previous build.\n',
        'data/fine.csv': 'sku,qty\nA-1,5\nA-2,2\n',
        // 101 columns, exactly one past the supported 100, so it is the limit being enforced
        // rather than something else refusing a wide file.
        'data/wide.csv': `${Array.from({ length: 101 }, (_, index) => `c${String(index)}`).join(
          ',',
        )}\n${Array.from({ length: 101 }, (_, index) => String(index)).join(',')}\n`,
      },
      setup: ['init'],
    },
    steps: [
      {
        action: 'run',
        args: ['build'],
        json: true,
        describe: 'The build succeeds, and only the over-wide table is missing from it',
        expect: {
          exitCode: 0,
          json: [
            // Every file is still an artifact, including the one that produced no table.
            { path: 'counts.artifacts', equals: 3 },
            // One table, from the narrow CSV. The wide one contributed none.
            { path: 'counts.tables', equals: 1 },
            { path: 'warnings', atLeast: 1 },
          ],
        },
      },
      {
        action: 'run',
        args: ['inspect', 'warnings'],
        describe: 'And the reason is recorded, naming the file, the count and the limit',
        expect: { exitCode: 0, stdout: { contains: ['data/wide.csv', '101 columns', '100'] } },
      },
      {
        action: 'run',
        args: ['search', 'delimited'],
        json: true,
        describe: 'The excluded file is still findable, and honest about not being imported',
        expect: {
          exitCode: 0,
          // Silence would be the one outcome worse than refusing: a file sitting in the
          // project with no trace of it in the build.
          json: [{ path: 'hits[0].locator.relativePath', matches: 'wide\\.csv' }],
        },
      },
    ],
  },

  {
    id: 'mixed/a-pdf-past-the-page-envelope-warns-and-is-still-read',
    title: 'A PDF longer than the envelope covers is read in full, with a warning saying so',
    proves: 'Section 5.4: beyond the envelope is untested, not refused.',
    mode: 'manual',
    fixture: { files: { 'docs/note.md': '# Note\n\nA placeholder.\n' }, setup: ['init'] },
    steps: [
      {
        action: 'note',
        text: 'Generate a text-layer PDF of more than 500 pages, put it in the project, and run `lore build`.',
        expect:
          'The build succeeds. `lore inspect warnings` names the file and its page count, says the envelope covers 500, and says it was read in full rather than truncated. Generating a 500-page PDF is the reason this is a note rather than an automated scenario: the fixture would dominate the suite runtime for one warning.',
      },
      {
        action: 'note',
        text: 'Then scan a page to an image, put a PDF containing only that page in the project, and build again.',
        expect:
          'The build succeeds and the file contributes nothing, with a warning saying it has no text layer on any page and that optical character recognition is out of scope. It is never silently absent, and no text is invented for it.',
      },
    ],
  },
];
