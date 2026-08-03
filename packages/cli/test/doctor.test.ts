import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorReportSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/services/doctor.js';

/**
 * `lore doctor`, whose entire value is the remediation.
 *
 * A check that reports "FTS5 unavailable" and stops has told the user what the failure that
 * sent them here already said. So the assertions below are mostly about whether a failing
 * check says something a person can act on, and whether the command is honest about an
 * environment that is fine.
 *
 * The last part is not hypothetical: the first version of the capability check used
 * `require` in an ESM module, so it reported a failure on a perfectly good Node. A doctor
 * that lies about the thing it exists to verify is worse than no doctor.
 */

const CORPUS = {
  'lore.yaml': 'version: 1\nname: examined\nsources:\n  - .\n',
  'a.md': '# A\n\nFirst.\n',
};

describe('a healthy environment', () => {
  it('passes every environment check, because this machine runs the test suite', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });

      for (const id of ['node-version', 'sqlite-capabilities', 'fts5']) {
        const check = report.checks.find((candidate) => candidate.id === id);
        expect(check?.status, `${id}: ${check?.detail}`).toBe('pass');
      }
    });
  });

  it('reports the SQLite version and executable, because "no FTS5" is usually "wrong Node"', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });
      const fts5 = report.checks.find((check) => check.id === 'fts5');

      expect(fts5?.values?.sqliteVersion).toMatch(/^\d+\.\d+/);
      expect(fts5?.values?.execPath).toBe(process.execPath);
    });
  });

  it('names each node:sqlite control separately, because they have different floors', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });
      const capabilities = report.checks.find((check) => check.id === 'sqlite-capabilities');

      // setAuthorizer 24.10, enableDefensive 24.14, limits 24.15: a user on an unexpected
      // build needs to know which one is missing, not that "something" is.
      expect(capabilities?.values?.setAuthorizer).toBe(true);
      expect(capabilities?.values?.enableDefensive).toBe(true);
      expect(capabilities?.values?.limits).toBe(true);
    });
  });
});

describe('the shape of the report', () => {
  it('validates against the committed schema', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });
      // Studio's Diagnostics route renders this same payload, and a bug report is asked for
      // `--json`, so the shape is a contract rather than an implementation detail.
      expect(() => doctorReportSchema.parse(report)).not.toThrow();
    });
  });

  it('gives every failing check something to do', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lore-doctor-'));
    try {
      writeFileSync(join(empty, 'lore.yaml'), 'version: 1\nname: [unclosed\n', 'utf8');
      const report = await runDoctor({ cwd: empty });

      const failures = report.checks.filter((check) => check.status === 'fail');
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure.remediation, `${failure.id} failed with no remediation`).toBeDefined();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('counts what it found, and takes the worst status as the verdict', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });
      const total = report.counts.pass + report.counts.warn + report.counts.fail;

      expect(total).toBe(report.checks.length);
      expect(report.status).toBe(
        report.counts.fail > 0 ? 'fail' : report.counts.warn > 0 ? 'warn' : 'pass',
      );
    });
  });
});

describe('outside a project', () => {
  it('reports the environment rather than refusing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lore-doctor-'));
    try {
      const report = await runDoctor({ cwd: empty });

      expect(report.project).toBeNull();
      // Checking your environment before there is anything to configure is a legitimate
      // thing to do, and the most likely moment to need it.
      expect(report.checks.map((check) => check.id)).toContain('fts5');
      expect(report.checks.map((check) => check.id)).not.toContain('config');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('a project that is new rather than broken', () => {
  it('treats having no build as worth knowing, not as a failure', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const report = await runDoctor({ cwd: project.root });
      const build = report.checks.find((check) => check.id === 'active-build');

      expect(build?.status).toBe('warn');
      expect(build?.remediation).toContain('lore build');
    });
  });
});

describe('a project that is broken', () => {
  it('says the configuration could not be read, and does not pretend to have checked sources', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'lore-doctor-'));
    try {
      writeFileSync(join(broken, 'lore.yaml'), 'version: 1\nname: [unclosed\n', 'utf8');
      const report = await runDoctor({ cwd: broken });

      expect(report.checks.find((check) => check.id === 'config')?.status).toBe('fail');
      // Not `pass`: reporting sources as fine when they were never examined would be the
      // command inventing a result.
      expect(report.checks.find((check) => check.id === 'sources')?.status).toBe('warn');
      expect(report.status).toBe('fail');
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('the dev port', () => {
  it('is a warning when occupied, because the supervisor steps to the next one', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      await withTempProject({ files: CORPUS }, async (project) => {
        const report = await runDoctor({ cwd: project.root, port });
        const check = report.checks.find((candidate) => candidate.id === 'dev-port');

        // Architecture 6.9: an occupied port is an ordinary condition of a developer
        // machine, so it must not make the whole report a failure.
        expect(check?.status).toBe('warn');
        expect(report.status).not.toBe('fail');
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
