import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BuildIdInputs,
  buildManifestSchema,
  deriveBuildId,
  hashCanonical,
  hashRoot,
} from '../src/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SPEC = join(ROOT, 'docs', 'package-format', 'README.md');
const EXAMPLE = join(ROOT, 'docs', 'package-format', 'worked-example.json');
const MANIFEST_SCHEMA = join(ROOT, 'schemas', 'build-manifest.json');

function documentedManifestFields(): Set<string> {
  const markdown = readFileSync(SPEC, 'utf8');
  const section = markdown
    .split('## Manifest Fields\n')[1]
    ?.split('\n## Canonical Serialization')[0];
  if (section === undefined) throw new Error('Manifest Fields section not found');
  const fields = new Set<string>();
  for (const line of section.split('\n')) {
    const match = line.match(/^\| `([^`]+)` \|/);
    if (match !== null) fields.add(match[1]);
  }
  return fields;
}

interface JsonSchema {
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
}

function schemaFields(schema: JsonSchema, prefix = ''): Set<string> {
  const fields = new Set<string>();
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    fields.add(path);
    const nested = child.properties !== undefined ? child : child.items;
    if (nested?.properties !== undefined) {
      for (const field of schemaFields(nested, path)) fields.add(field);
    }
  }
  return fields;
}

describe('package format documentation', () => {
  it('documents every build manifest schema field and no invented manifest field', () => {
    const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA, 'utf8')) as JsonSchema;
    const documented = documentedManifestFields();
    const fromSchema = schemaFields(schema);
    expect([...documented].sort()).toEqual([...fromSchema].sort());
  });

  it('keeps the worked example manifest valid and its build id reproducible', () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as {
      memberHashes: {
        artifactHash: string;
        nodeHash: string;
        chunkHash: string;
        objectHash: string;
      };
      buildIdInputs: BuildIdInputs;
      manifest: unknown;
    };
    const manifest = buildManifestSchema.parse(example.manifest);

    expect(hashRoot([example.memberHashes.artifactHash])).toBe(
      example.buildIdInputs.canonicalRoots.artifacts,
    );
    expect(hashRoot([example.memberHashes.nodeHash])).toBe(
      example.buildIdInputs.canonicalRoots.nodes,
    );
    expect(hashRoot([example.memberHashes.chunkHash])).toBe(
      example.buildIdInputs.canonicalRoots.chunks,
    );
    expect(hashRoot([])).toBe(example.buildIdInputs.canonicalRoots.tables);
    expect(hashRoot([example.memberHashes.objectHash])).toBe(
      example.buildIdInputs.canonicalRoots.objects,
    );
    expect(hashCanonical(example.buildIdInputs.effectiveConfig)).toBe(manifest.configurationHash);
    expect(deriveBuildId(example.buildIdInputs)).toBe(manifest.buildId);
  });
});
