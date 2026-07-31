#!/usr/bin/env node
import { dirname, join } from 'node:path';
// Verifies a delivery phase against its executable acceptance criteria.
//   pnpm phase:check 0            human-readable report
//   pnpm phase:check 0 --json     machine-readable report
// Exit codes: 0 passed, 1 failed, 2 unverified. See docs/architecture/phase-gates.md
import { fileURLToPath } from 'node:url';
import { checkPhase, EXIT, formatReport, phaseDefinition } from '../tools/phase-gate/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const phase = Number(args.find((arg) => /^\d+$/.test(arg)) ?? '0');

const definition = phaseDefinition(phase);
if (definition === null) {
  console.error(`Phase ${phase} has no executable criteria yet.`);
  console.error('Add a definition under tools/phase-gate/src/phases/ before relying on this gate.');
  process.exit(EXIT.unverified);
}

const report = await checkPhase(definition, { repoRoot });
console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(EXIT[report.outcome]);
