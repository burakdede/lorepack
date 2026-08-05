import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lorepack must never claim it detected a conflict, or decided which document is correct.
 *
 * This is invariant 6 and architecture section 13.4, and it is the one product promise that a
 * single well-meaning sentence can break. Someone writing an error message, a Studio label or
 * a tool description reaches for "conflicting sources" because it reads naturally, and the
 * product silently starts asserting something it cannot know.
 *
 * So it is checked mechanically, over every user-facing string in the repository, the same way
 * the em dash is. The rule is not "avoid the word conflict": it is that Lorepack may never
 * present itself as having *found* one. `authority` is a hint a user declared; two documents
 * that disagree are two documents, and Lorepack lists them with their labels and says nothing
 * about which is right.
 */

const ROOTS = ['packages', 'tools', 'scripts', 'docs', 'README.md'];
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', 'studio-dist', 'fixtures']);
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|md|json|yaml|yml)$/;

/**
 * Phrasings that assert a judgement Lorepack has not made.
 *
 * Each is a claim about the *world* rather than about the configuration: that a disagreement
 * exists, that one document wins on merit, or that something was found to be wrong. The
 * allowed forms are the opposite in every case, and they are what the codebase already uses:
 * "superseded by declaration", "alternatives", "you declared".
 */
const FORBIDDEN = [
  { pattern: /detect(?:ed|s|ing)?\s+(?:a\s+)?conflict/i, why: 'claims a conflict was found' },
  {
    pattern: /conflict(?:ing)?\s+(?:sources?|documents?|files?)/i,
    why: 'asserts sources conflict',
  },
  // Narrow on purpose. A bare `contradict` catches ordinary prose about two CLI messages
  // disagreeing, which is a real thing to write about and not a claim about anyone's
  // documents. What is forbidden is saying that *sources* contradict.
  {
    pattern: /(?:documents?|sources?|files?|versions?)\s+(?:that\s+)?contradict/i,
    why: 'asserts one document contradicts another',
  },
  {
    pattern: /contradict(?:s|ed|ing)\s+(?:the\s+)?(?:documents?|sources?|files?)/i,
    why: 'asserts one document contradicts another',
  },
  {
    pattern: /(?:this|the)\s+(?:document|source|file)\s+is\s+(?:wrong|incorrect|outdated)/i,
    why: 'judges a document',
  },
  {
    pattern: /more\s+(?:authoritative|correct|accurate|reliable)\s+than/i,
    why: 'ranks documents on merit',
  },
  {
    pattern: /(?:the\s+)?correct\s+(?:version|answer|document|source)\s+is/i,
    why: 'names a correct document',
  },
  {
    pattern: /disagree(?:s|ment)\s+(?:was\s+)?(?:found|detected)/i,
    why: 'claims a disagreement was found',
  },
  {
    pattern: /out\s+of\s+date\s+(?:compared|relative)\s+to/i,
    why: 'judges freshness Lorepack cannot know',
  },
];

/**
 * Lines that are allowed to contain a forbidden phrase because they **forbid** it.
 *
 * This file, and any line that is plainly stating the rule rather than breaking it. Without
 * this the check could not describe what it checks, and the tests that assert the rule could
 * not name the thing they assert.
 */
const ALLOWED_MARKERS = [
  // An assertion that the phrase is absent is the rule being enforced, not broken. Without
  // this the check would forbid the tests that exist to prove it holds.
  'not.tomatch',
  'not.tocontain',
  'not.tocontainequal',
  'check-no-conflict-claims',
  'never claim',
  'never claims',
  'must never',
  'may never',
  'cannot claim',
  'does not detect',
  'never detect',
  'no automatic conflict',
  'automatic conflict detection',
  'forbidden',
  'lore-allow-conflict-copy',
];

const problems = [];

function walk(path) {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue;
      walk(join(path, entry));
    }
    return;
  }
  if (!TEXT.test(path)) return;
  // This file names every forbidden phrase in order to look for it.
  if (path.endsWith('check-no-conflict-claims.mjs')) return;

  const text = readFileSync(path, 'utf8');
  for (const [index, line] of text.split('\n').entries()) {
    const lower = line.toLowerCase();
    if (ALLOWED_MARKERS.some((marker) => lower.includes(marker))) continue;
    for (const { pattern, why } of FORBIDDEN) {
      if (!pattern.test(line)) continue;
      problems.push({ path, line: index + 1, why, text: line.trim().slice(0, 100) });
    }
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A root that does not exist in this checkout is not a failure.
  }
}

if (problems.length > 0) {
  console.error('Lorepack must never claim it detected a conflict (invariant 6, section 13.4).\n');
  for (const problem of problems) {
    console.error(`  ${problem.path}:${problem.line}  ${problem.why}`);
    console.error(`    ${problem.text}`);
  }
  console.error(
    '\nSay what was declared, not what is true: "superseded by your rules", "alternatives",',
  );
  console.error('"you declared this authority". Lorepack never decides which document is right.');
  process.exit(1);
}

console.log('check:no-conflict-claims: clean');
