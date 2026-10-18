import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const PARSER = join(import.meta.dirname, '..', 'dist', 'csv', 'parser.js');
const CORE = join(import.meta.dirname, '..', '..', 'core', 'dist', 'index.js');
const MIB = 1024 * 1024;
const PEAK_RSS_CEILING = 512 * MIB;
const CASES = [
  { name: 'rows.csv', bytes: 64 * MIB, shape: 'rows', warning: 'csv-too-many-rows' },
  { name: 'cols.csv', bytes: 64 * MIB, shape: 'columns', warning: 'csv-too-many-columns' },
  { name: 'rows8.csv', bytes: 8 * MIB, shape: 'rows', warning: 'csv-too-many-rows' },
] as const;

it.each(CASES)(
  '$name returns a typed CSV limit within the RSS ceiling',
  (fixture) => {
    expect(existsSync(PARSER), 'Build the actual CSV parser before this regression.').toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'lore-csv-limit-'));
    try {
      const path = join(root, fixture.name);
      const bytes = Buffer.alloc(fixture.bytes, fixture.shape === 'rows' ? 'a\n' : ',');
      if (fixture.shape === 'columns') bytes[0] = 97;
      writeFileSync(path, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      process.stdout.write(
        `${JSON.stringify({
          stage: 'input',
          fixture: fixture.name,
          byteSize: fixture.bytes,
          sha256: hash,
          heapLimitMiB: 256,
          ceilingBytes: PEAK_RSS_CEILING,
        })}\n`,
      );
      const code = `
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {csvParser} from ${JSON.stringify(pathToFileURL(PARSER).href)};
import {hashBytes} from ${JSON.stringify(pathToFileURL(CORE).href)};
const path=process.argv[1];
const bytes=readFileSync(path);
const relativePath=basename(path);
const input={artifactId:'fixture:'+relativePath,sourceId:'fixture',relativePath,displayPath:relativePath,
 mediaType:'text/csv',byteSize:bytes.byteLength,contentHash:hashBytes(bytes),bytes};
const parsed=await csvParser.parse(input);
console.log(JSON.stringify({
 artifact:parsed.artifact,warnings:parsed.warnings,tables:parsed.tables?.length??0,
 nodes:parsed.nodes.map(node=>({locator:node.locator,metadata:node.metadata})),
 peakRssBytes:process.resourceUsage().maxRSS*1024,node:process.version,platform:process.platform
}));
`;
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=256', '--input-type=module', '-e', code, path],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.signal ?? ''}\n${result.stderr}`).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        artifact: { id: string; relativePath: string; byteSize: number; contentHash: string };
        warnings: { code: string; loss?: unknown }[];
        tables: number;
        nodes: {
          locator: { artifactId: string; relativePath: string };
          metadata?: { imported?: boolean; rowCount?: number };
        }[];
        peakRssBytes: number;
        node: string;
        platform: string;
      };
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({ code: fixture.warning, loss: {} }),
      );
      expect(parsed.tables).toBe(0);
      expect(parsed.artifact).toMatchObject({
        relativePath: fixture.name,
        byteSize: fixture.bytes,
        contentHash: hash,
      });
      expect(parsed.nodes.some((node) => node.metadata?.imported === false)).toBe(true);
      expect(parsed.nodes.every((node) => node.metadata?.rowCount === undefined)).toBe(true);
      for (const node of parsed.nodes) {
        expect(node.locator).toMatchObject({
          artifactId: parsed.artifact.id,
          relativePath: fixture.name,
        });
      }
      expect(Number.isSafeInteger(parsed.peakRssBytes)).toBe(true);
      expect(parsed.peakRssBytes).toBeGreaterThan(0);
      expect(parsed.peakRssBytes).toBeLessThan(PEAK_RSS_CEILING);
      process.stdout.write(
        `${JSON.stringify({
          fixture: fixture.name,
          byteSize: fixture.bytes,
          sha256: hash,
          peakRssBytes: parsed.peakRssBytes,
          ceilingBytes: PEAK_RSS_CEILING,
          warning: fixture.warning,
          node: parsed.node,
          platform: parsed.platform,
        })}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  130_000,
);
