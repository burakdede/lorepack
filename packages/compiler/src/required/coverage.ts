import {
  type Artifact,
  type EffectiveConfig,
  LoreError,
  type LoreNode,
  type ParserWarning,
} from '@lorepack/core';

export interface CoverageArtifact {
  readonly artifact: Pick<Artifact, 'displayPath'>;
  readonly nodes: readonly Pick<LoreNode, 'kind' | 'metadata'>[];
  readonly warnings?: readonly ParserWarning[];
}

export interface CoverageWarning {
  readonly code:
    | 'required-source-unavailable'
    | 'required-source-incomplete'
    | 'required-sheet-unavailable';
  readonly path: string;
  readonly message: string;
}

export function checkRequiredCoverage(
  config: EffectiveConfig['build'],
  artifacts: readonly CoverageArtifact[],
): readonly CoverageWarning[] {
  const byPath = new Map(
    artifacts.map((entry) => [entry.artifact.displayPath.normalize('NFC'), entry]),
  );
  const warnings: CoverageWarning[] = [];
  for (const required of config.required) {
    const entry = byPath.get(required.path);
    if (entry === undefined) {
      warnings.push({
        code: 'required-source-unavailable',
        path: required.path,
        message: `Required source ${required.path} was not imported. It is missing, excluded or unreadable.`,
      });
      continue;
    }
    for (const sheet of required.sheets ?? []) {
      const node = entry.nodes.find(
        (node) => node.kind === 'sheet' && node.metadata.sheet === sheet,
      );
      if (node === undefined || node.metadata.imported !== true) {
        warnings.push({
          code: 'required-sheet-unavailable',
          path: required.path,
          message: `Required sheet ${JSON.stringify(sheet)} in ${required.path} was not imported as a table.`,
        });
      }
    }
    const losses = (entry.warnings ?? []).filter(
      (warning) =>
        warning.loss !== undefined &&
        (required.sheets === undefined ||
          warning.loss.sheet === undefined ||
          required.sheets.includes(warning.loss.sheet)),
    );
    for (const warning of losses) {
      warnings.push({
        code: 'required-source-incomplete',
        path: required.path,
        message: `Required source ${required.path} has incomplete coverage: ${warning.message}`,
      });
    }
  }
  const first = warnings[0];
  if (first !== undefined && config.profile === 'strict') {
    throw new LoreError(
      'LORE_E_REQUIRED_COVERAGE',
      `Strict build rejected required source coverage. ${first.message}`,
      {
        remediation:
          'Restore or include the required input, fix the named extraction loss, or explicitly change the required declaration. The active build is unchanged.',
        path: first.path,
        details: { failures: warnings },
      },
    );
  }
  return warnings;
}
