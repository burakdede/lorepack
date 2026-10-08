import { discoverPublishablePackages, findMissingPackages } from './release-packages.mjs';

const missing = findMissingPackages(discoverPublishablePackages());

if (missing.length > 0) {
  console.error('npm package bootstrap is incomplete. Missing packages:');
  for (const packageJson of missing) console.error(`- ${packageJson.name}`);
  console.error(
    'Create each package once and configure its npm Trusted Publisher before the real release.',
  );
  process.exitCode = 1;
} else {
  console.log('all publishable npm packages exist in the registry');
}
