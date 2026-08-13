#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LORE = join(ROOT, 'packages', 'cli', 'dist', 'entry.js');
const PRODUCT = join(ROOT, 'examples', 'product-research');
const CODING = join(ROOT, 'examples', 'coding-project');
const args = new Set(process.argv.slice(2));
const check = args.has('--check');

if (!existsSync(LORE)) {
  console.error('demo: build the CLI first with `pnpm build`.');
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), 'lore-demo-'));
const transcript = [];

try {
  const product = copyExample(PRODUCT, workspace);
  const coding = copyExample(CODING, workspace);

  step('start', product, ['plan']);
  step('start', product, ['build']);
  assertIncludes(lastStdout(), ['Build lore_', 'Activated']);

  const firstBuild = readActiveBuild(product);
  append(
    join(product, 'sources', 'research', 'current', 'positioning.md'),
    '\n## Demo Edit\n\nThe demo proves that source changes produce an inspectable plan before a new build activates.\n',
  );
  step('change', product, ['plan']);
  assertIncludes(lastStdout(), ['~ 1 changed']);
  step('change', product, ['build']);
  const secondBuild = readActiveBuild(product);
  if (firstBuild === secondBuild) throw new Error('changing a source did not produce a new build');

  step('recover', product, ['diff', firstBuild, secondBuild]);
  assertIncludes(lastStdout(), ['research/current/positioning.md']);
  step('recover', product, ['rollback']);
  assertIncludes(lastStdout(), [firstBuild]);
  if (readActiveBuild(product) !== firstBuild)
    throw new Error('rollback did not restore first build');

  const archive = join(workspace, `${basename(product)}.lorepack`);
  step('deploy-ready', product, ['pack', '--out', archive]);
  step('deploy-ready', product, ['pack', '--verify', archive]);
  assertIncludes(lastStdout(), ['is intact']);

  step('coding-context', coding, ['build']);
  step('coding-context', coding, [
    'export',
    '--task',
    'How should the sync worker recover after a failed deploy?',
  ]);
  assertIncludes(lastStdout(), ['ADR 0001', 'receipt']);

  const rendered = renderTranscript(transcript);
  const target = join(ROOT, 'docs', 'demo-transcript.md');
  if (check) {
    const current = readFileSync(target, 'utf8');
    if (current !== rendered) {
      console.error('demo: docs/demo-transcript.md is stale.');
      console.error('Run `pnpm demo:readme` and commit the result.');
      process.exit(1);
    }
    console.log('demo: README demo and transcript are current');
  } else {
    writeFileSync(target, rendered);
    console.log('demo: wrote docs/demo-transcript.md');
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function copyExample(source, workspace) {
  const target = join(workspace, basename(source));
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('.lore'),
  });
  return target;
}

function step(label, cwd, command) {
  const result = run(command, cwd);
  transcript.push({ label, cwd: basename(cwd), command, ...result });
  if (result.status !== 0) {
    throw new Error(`lore ${command.join(' ')} failed with exit ${result.status}`);
  }
}

function run(command, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [LORE, '--cwd', cwd, ...command], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function lastStdout() {
  return transcript.at(-1)?.stdout ?? '';
}

function assertIncludes(text, needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(`expected output to include ${JSON.stringify(needle)}\n${text}`);
    }
  }
}

function append(path, text) {
  writeFileSync(path, `${readFileSync(path, 'utf8')}${text}`);
}

function readActiveBuild(project) {
  const pointer = join(project, '.lore', 'active-build');
  if (existsSync(pointer)) return readFileSync(pointer, 'utf8').trim();
  const state = join(project, '.lore', 'state.sqlite');
  if (!existsSync(state)) throw new Error('active build pointer is missing');
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1], {readOnly:true}); const row=db.prepare('SELECT build_id FROM active_build WHERE id = 1').get(); if (!row?.build_id) process.exit(1); console.log(row.build_id); db.close();",
      state,
    ],
    { encoding: 'utf8' },
  );
  return output.trim();
}

function renderTranscript(entries) {
  const lines = [
    '# Demo transcript',
    '',
    '<!-- Generated by scripts/demo-readme.mjs. Do not edit by hand. -->',
    '',
    'This transcript is regenerated by `pnpm demo:readme` from the checked-in examples.',
    '',
  ];
  for (const entry of entries) {
    lines.push(`## ${entry.label}: ${entry.cwd}`);
    lines.push('');
    lines.push('```bash');
    lines.push(`lore ${normalizeCommand(entry.command).map(shellWord).join(' ')}`);
    lines.push('```');
    lines.push('');
    lines.push('```text');
    lines.push(normalizeOutput(trimOutput(entry.stdout || entry.stderr)));
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n').replaceAll(/\n{3,}/g, '\n\n')}\n`;
}

function normalizeCommand(command) {
  return command.map((value) =>
    value
      .replaceAll(/lore_[0-9a-f]{64}/g, 'lore_<build-id>')
      .replaceAll(/.*lore-demo-[^/\s]+/g, '<demo-workspace>'),
  );
}

function shellWord(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

function trimOutput(value) {
  return value
    .split('\n')
    .filter((line) => !line.startsWith('warning: reclaimed a stale lock'))
    .join('\n')
    .trim();
}

function normalizeOutput(value) {
  return value
    .replaceAll(/lore_[0-9a-f]{64}/g, 'lore_<build-id>')
    .replaceAll(/lore_[0-9a-f]{13}/g, 'lore_<build-prefix>')
    .replaceAll(/lore_[0-9a-f]{13} -> candidate/g, 'lore_<build-prefix> -> candidate')
    .replaceAll(/\/[^ \n]*lore-demo-[^ \n]*/g, '<demo-workspace>')
    .replaceAll(/Activated in \d+ ms\./g, 'Activated in <elapsed> ms.')
    .replaceAll(/\s+\d+ms/g, ' <elapsed>ms');
}
