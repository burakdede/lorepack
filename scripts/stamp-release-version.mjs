import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_VERSION = process.env.RELEASE_VERSION;

export function stampReleaseVersion(root, version) {
  const manifests = [
    'package.json',
    ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}/package.json`),
  ];

  for (const manifest of manifests) {
    const path = join(root, manifest);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.private === true && manifest !== 'package.json') continue;
    data.version = version;
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  const stableVersion = version.split('-')[0];
  const releaseHeading = new RegExp(`^## ${escapeRegExp(stableVersion)}$`, 'm');
  for (const name of readdirSync(join(root, 'packages'))) {
    const path = join(root, 'packages', name, 'CHANGELOG.md');
    let changelog;
    try {
      changelog = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    const heading = releaseHeading.exec(changelog);
    if (heading === null) continue;

    const sectionStart = heading.index;
    const contentStart = sectionStart + heading[0].length;
    const nextSection = changelog.indexOf('\n## ', contentStart);
    const sectionEnd = nextSection === -1 ? changelog.length : nextSection;
    const section = changelog
      .slice(sectionStart, sectionEnd)
      .replace(heading[0], `## ${version}`)
      .replace(/(@lorepack\/[A-Za-z0-9._-]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1@${version}`);
    writeFileSync(
      path,
      `${changelog.slice(0, sectionStart)}${section}${changelog.slice(sectionEnd)}`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (RELEASE_VERSION !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampReleaseVersion(process.cwd(), RELEASE_VERSION);
}
