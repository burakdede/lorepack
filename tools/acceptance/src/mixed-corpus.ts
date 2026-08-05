import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A realistic mixed folder, generated rather than committed.
 *
 * Milestone 2's exit criterion (architecture section 21) is that **a real mixed project folder
 * produces useful bounded context with reliable provenance and spreadsheet queries**. Every
 * word of that needs more than Markdown: provenance means a page number for a PDF and a cell
 * range for a spreadsheet, and a spreadsheet query needs a spreadsheet.
 *
 * Generated because a repository full of binary fixtures is one nobody can review in a diff,
 * and because the same generators already produce the bytes the parser unit tests are written
 * against, so the two cannot describe different files.
 *
 * The content is deliberately **cross-referential**: the runbook names a threshold that lives
 * in the spreadsheet, and the incident note names the environment the CSV prices. A bundle
 * that cites a document and a table is only a meaningful assertion if a real task genuinely
 * needs both.
 */

const RUNBOOK = [
  '---',
  'authority: 90',
  'status: active',
  '---',
  '',
  '# Release runbook',
  '',
  '## Rolling back',
  '',
  'Run `lore rollback` to point at the previous build. Activation is a pointer change, so',
  'nothing is recompiled and no source file is touched.',
  '',
  '## Paging thresholds',
  '',
  'A critical environment pages on the first failed health check. The per-environment tiers',
  'and their monthly costs are held in the environments spreadsheet, not here, because they',
  'change on a different schedule from this document.',
  '',
].join('\n');

const INCIDENT = [
  '# Incident 2026-07-14: checkout latency',
  '',
  '## What happened',
  '',
  'The production environment in eu-west-1 served checkout requests slowly for forty minutes',
  'after a deployment. Rolling back restored the previous latency within two minutes.',
  '',
  '## Follow-up',
  '',
  'Confirm the paging tier for production against the environments spreadsheet.',
  '',
].join('\n');

/** A CSV, which becomes a typed table with a nullable real and a boolean. */
const PRICING = [
  'sku,list_price,currency,discontinued',
  'A-1,19.99,USD,false',
  'A-2,4.50,EUR,false',
  'A-3,,USD,true',
  '',
].join('\n');

const NOTES = [
  'Sprint notes.',
  '',
  'The retention pipeline still runs nightly. Nothing about paging changed this sprint.',
  '',
].join('\n');

/**
 * Writes one file of every supported format into `project`.
 *
 * Returns the relative paths written, so a scenario can be asserted against the set rather
 * than against a list typed out a second time.
 */
export async function writeMixedCorpus(project: string): Promise<readonly string[]> {
  // Imported here rather than at the top of the file, and that is not a style choice.
  // `@lorepack/test-support` exports TypeScript source, with no build step, because every
  // other consumer is a test file that a transpiling runner already owns. This package does
  // compile, and `scripts/generate-acceptance-doc.mjs` loads its `dist/`, so a static import
  // would make the doc generator try to load a `.ts` file from plain Node and fail. A lazy
  // import is only reached by a scenario that asks for a mixed fixture, which only ever
  // happens under the test runner.
  const { inlineString, makeDocx, makePdf, makeXlsx, number, paragraph, row } = await import(
    '@lorepack/test-support'
  );

  const docs = join(project, 'docs');
  const data = join(project, 'data');
  mkdirSync(docs, { recursive: true });
  mkdirSync(data, { recursive: true });

  writeFileSync(join(docs, 'runbook.md'), RUNBOOK, 'utf8');
  writeFileSync(join(docs, 'incident.md'), INCIDENT, 'utf8');
  writeFileSync(join(docs, 'notes.txt'), NOTES, 'utf8');

  writeFileSync(
    join(docs, 'policy.html'),
    [
      '<!doctype html><html><head><title>Access policy</title></head><body>',
      '<nav>skip me</nav>',
      '<h1>Access policy</h1>',
      '<h2>Requesting access</h2>',
      '<p>Ask in the engineering channel. Access is reviewed every quarter.</p>',
      '<footer>skip me too</footer>',
      '</body></html>',
    ].join('\n'),
    'utf8',
  );

  // Two pages, so a citation naming a page number is distinguishable from one that guessed.
  writeFileSync(
    join(docs, 'contract.pdf'),
    makePdf(
      [
        { lines: ['Support contract', 'Response times are measured in business hours.'] },
        { lines: ['Escalation', 'A critical incident escalates after thirty minutes.'] },
      ],
      { title: 'Support contract' },
    ),
  );

  writeFileSync(
    join(docs, 'onboarding.docx'),
    await makeDocx({
      body: [
        paragraph('Onboarding', 'Heading1'),
        paragraph('Accounts', 'Heading2'),
        paragraph('A new engineer is granted repository access on their first day.'),
      ].join(''),
    }),
  );

  writeFileSync(join(data, 'pricing.csv'), PRICING, 'utf8');

  writeFileSync(
    join(data, 'environments.xlsx'),
    await makeXlsx({
      sheets: [
        {
          name: 'Environments',
          rows: [
            row(1, [
              inlineString('A1', 'environment'),
              inlineString('B1', 'region'),
              inlineString('C1', 'tier'),
              inlineString('D1', 'monthly_cost_usd'),
            ]),
            row(2, [
              inlineString('A2', 'production'),
              inlineString('B2', 'eu-west-1'),
              inlineString('C2', 'critical'),
              number('D2', 4210.5),
            ]),
            row(3, [
              inlineString('A3', 'staging'),
              inlineString('B3', 'eu-west-1'),
              inlineString('C3', 'standard'),
              number('D3', 318.75),
            ]),
            row(4, [
              inlineString('A4', 'sandbox'),
              inlineString('B4', 'us-east-1'),
              inlineString('C4', 'standard'),
              number('D4', 96.2),
            ]),
          ].join(''),
        },
      ],
    }),
  );

  return [
    'data/environments.xlsx',
    'data/pricing.csv',
    'docs/contract.pdf',
    'docs/incident.md',
    'docs/notes.txt',
    'docs/onboarding.docx',
    'docs/policy.html',
    'docs/runbook.md',
  ];
}
