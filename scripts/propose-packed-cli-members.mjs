import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTarMembers } from './packed-cli-members.mjs';

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--tarball' || args[2] !== '--out') {
    console.error('usage: propose-packed-cli-members.mjs --tarball <tgz> --out <new file>');
    process.exit(1);
  }
  const listed = listTarMembers(resolve(args[1]));
  if (listed.problems.length > 0) throw new Error(listed.problems.join('\n'));
  writeFileSync(resolve(args[3]), `${[...listed.members].sort().join('\n')}\n`, { flag: 'wx' });
  console.log(`wrote ${listed.members.size} proposed member paths for review`);
}
