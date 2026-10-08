#!/usr/bin/env node
import { join } from 'node:path';
import { readAndValidateBenchmarkReport } from './benchmark-report.mjs';

const root = join(import.meta.dirname, '..');
const sample = join(root, 'benchmarks/protocol/sample-report.json');
const { problems } = readAndValidateBenchmarkReport(sample);

if (problems.length > 0) {
  console.error('check:benchmark-protocol failed.');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log('check:benchmark-protocol: sample report conforms to protocol v1');
