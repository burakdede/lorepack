import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function validMember(name) {
  return (
    name.startsWith('package/') &&
    !name.includes('\\') &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function parseMembers(output, source) {
  const lines = output.replace(/\r?\n$/, '').split(/\r?\n/);
  const members = new Set();
  const problems = [];
  for (const name of lines) {
    if (!validMember(name))
      problems.push(`${source}: unsafe tarball member ${JSON.stringify(name)}`);
    else if (members.has(name)) problems.push(`${source}: duplicate tarball member ${name}`);
    else members.add(name);
  }
  if (members.size === 0) problems.push(`${source}: empty tarball member list`);
  return { members, problems };
}

export function compareMembers(expected, actual) {
  return [
    ...[...actual]
      .filter((name) => !expected.has(name))
      .sort()
      .map((name) => `unexpected tarball member: ${name}`),
    ...[...expected]
      .filter((name) => !actual.has(name))
      .sort()
      .map((name) => `missing tarball member: ${name}`),
  ];
}

export function readReviewedMembers(path) {
  if (!existsSync(path)) throw new Error(`reviewed tarball member allow-list is missing: ${path}`);
  const content = readFileSync(path, 'utf8');
  const listed = parseMembers(content, 'reviewed allow-list');
  if (listed.problems.length > 0) throw new Error(listed.problems.join('\n'));
  const sorted = [...listed.members].sort();
  if (`${sorted.join('\n')}\n` !== content) {
    throw new Error('reviewed allow-list must contain sorted paths with one trailing newline');
  }
  return listed.members;
}

export function listTarMembers(tarball) {
  const result = spawnSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar -tzf ${tarball} failed (exit ${result.status})\n${result.stderr ?? ''}`);
  }
  return parseMembers(result.stdout, 'packed tarball');
}
