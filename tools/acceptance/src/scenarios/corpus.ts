/**
 * The corpus every ordinary scenario builds on.
 *
 * Three artifacts, two formats, and headings deep enough that a chunk has a real heading
 * path. Small on purpose: a scenario about rollback should fail because rollback broke,
 * not because a fixture got large enough to time out on the slowest runner.
 */
export const CORPUS: Readonly<Record<string, string>> = {
  'guides/onboarding.md':
    '# Onboarding\n\nNew engineers configure their laptop on day one.\n\n## Access\n\nRequest VPN access from the platform team.\n',
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release without recompiling. VPN access is required.\n',
  'notes/standup.txt': 'Discussed the deployment schedule and rollback safety.\n',
};

/** The same corpus with one file edited, for the scenarios that change something. */
export const EDITED_ONBOARDING =
  '# Onboarding\n\nNew engineers configure their laptop on day one.\n\n## Access\n\nRequest VPN access from the platform team.\n\n## Buddy\n\nEveryone is assigned a buddy for their first week.\n';
