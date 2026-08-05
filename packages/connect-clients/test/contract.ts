import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClientConnector, ConnectInput, ConnectReceipt } from '../src/port.js';

/**
 * The properties every `ClientConnector` must have, run against each adapter.
 *
 * This is the connector version of what the working agreement §7 already requires of stores:
 * one shared suite, every implementation. It exists because the risk here is not
 * adapter-specific. Whatever the file format, the file already belongs to someone, it holds
 * servers they configured by hand, and they will keep using the project afterwards.
 * Architecture 24.8 names corrupting it as a real risk, and each test below is a way of doing
 * exactly that.
 *
 * Adapter-specific behaviour stays in the adapter's own test file. What lives here is only
 * what would be a defect in *any* connector, so a third client cannot arrive with a fresh way
 * to lose someone's configuration.
 */

export interface ConnectorFixture {
  readonly id: string;
  readonly title: string;
  /** A connector wired to this project, with the client reporting itself installed. */
  create(project: string): ClientConnector;
  /** A connector whose client binary is absent. */
  createMissing(project: string): ClientConnector;
  /** Writes a configuration holding a server someone else set up, plus one unrelated setting. */
  seedForeign(project: string): string;
  /** The unrelated setting `seedForeign` wrote, read back from the file. */
  unrelatedSetting(text: string): boolean;
  /** Writes an entry under our own name that Lorepack did **not** create. */
  seedImpostor(project: string): string;
  /** Every server name the file declares. */
  serverNames(text: string): readonly string[];
  /** One server entry, as the client would read it. */
  entry(
    text: string,
    name: string,
  ): { readonly command?: string; readonly args?: readonly string[] } | undefined;
}

const SERVER_NAME = 'lorepack';

export function runConnectorContract(fixture: ConnectorFixture, project: () => string): void {
  const input = (overrides: Partial<ConnectInput> = {}): ConnectInput => ({
    projectRoot: project(),
    serverName: SERVER_NAME,
    command: {
      executable: 'lore',
      args: ['mcp', '--project', project(), '--ensure-current'],
    },
    scope: 'project',
    ...overrides,
  });

  const read = (path: string): string => readFileSync(path, 'utf8');

  const receiptFor = (path: string): ConnectReceipt => ({
    clientId: fixture.id,
    scope: 'project',
    projectRoot: project(),
    serverName: SERVER_NAME,
    configPath: path,
    connectedAt: new Date().toISOString(),
  });

  describe(`${fixture.title}: the connector contract`, () => {
    describe('detection', () => {
      it('reports the version the client gives', async () => {
        const detected = await fixture.create(project()).detect();

        expect(detected.installed).toBe(true);
        expect(detected.version).toBeTruthy();
        expect(detected.supported).toBe(true);
      });

      it('reports a missing client as not installed, rather than failing', async () => {
        const detected = await fixture.createMissing(project()).detect();

        // Not an error: a machine without this client is an ordinary machine, and
        // `lore connect` has other clients and a snippet to offer.
        expect(detected.installed).toBe(false);
        expect(detected.reason).toBeTruthy();
      });
    });

    /**
     * Status, which Studio's Diagnostics route asks for on every visit. Two properties matter,
     * and neither is about the answer being right: it must write nothing, and it must
     * distinguish an entry Lorepack created from one a person wrote under the same name.
     */
    describe('status', () => {
      it('reports not configured, and creates nothing by asking', async () => {
        const connector = fixture.create(project());
        const status = await connector.status(input());

        expect(status.configured).toBe(false);
        expect(status.ownedByLorepack).toBe(false);
        expect(status.configPath).toBeTruthy();
        expect(existsSync(status.configPath as string)).toBe(false);
      });

      it('reports an entry Lorepack created as its own', async () => {
        const connector = fixture.create(project());
        await connector.apply(await connector.plan(input()));

        const status = await connector.status(input());
        expect(status.configured).toBe(true);
        expect(status.ownedByLorepack).toBe(true);
      });

      it('reports an entry someone wrote by hand as theirs', async () => {
        fixture.seedImpostor(project());
        const status = await fixture.create(project()).status(input());

        expect(status.configured).toBe(true);
        // Claiming credit here is how `disconnect` later deletes something it did not create.
        expect(status.ownedByLorepack).toBe(false);
      });
    });

    describe('planning, before anything is written', () => {
      it('names the file and the exact command, and writes nothing', async () => {
        const plan = await fixture.create(project()).plan(input());

        expect(plan.configPath).toBeTruthy();
        expect(plan.changes.join('\n')).toContain('lore mcp --project');
        // `--dry-run` is the orchestrator's flag; the guarantee it rests on is that planning
        // itself never touches the disk.
        expect(existsSync(plan.configPath as string)).toBe(false);
      });

      /**
       * Carried, never recovered from the configuration path.
       *
       * An adapter that strips `.vscode/mcp.json` off the path and rejoins the rest gets
       * `C:/Users/me/project` from `C:\\Users\\me\\project` on Windows, every ownership check
       * then answers "not ours", and `disconnect` quietly stops working. Windows CI caught
       * that on #81; this assertion catches it everywhere.
       */
      it('carries the project root it was given, byte for byte', async () => {
        const connector = fixture.create(project());
        const plan = await connector.plan(input());
        expect(plan.projectRoot).toBe(project());

        const receipt = await connector.apply(plan);
        expect(receipt.projectRoot).toBe(project());
      });

      it('defaults to the project, never the user scope', async () => {
        const plan = await fixture.create(project()).plan(input());

        // A connector that quietly writes a user-scope entry configures every project on the
        // machine to read one project's documents (architecture 6.6).
        expect(plan.scope).toBe('project');
        expect(plan.configPath).toContain(project());
      });

      it('says it is updating, not adding, when Lorepack already configured this project', async () => {
        const connector = fixture.create(project());
        await connector.apply(await connector.plan(input()));

        const second = await connector.plan(input());
        expect(second.changes.join('\n')).toMatch(/[Uu]pdate the existing Lorepack server/);
      });

      it('says plainly when it would replace a server it did not create', async () => {
        fixture.seedImpostor(project());
        const plan = await fixture.create(project()).plan(input());

        // The user sees this before it happens, which is the entire purpose of a plan.
        expect(plan.changes.join('\n')).toContain('Lorepack did not create');
      });
    });

    describe('applying', () => {
      it('keeps every server that was already there, and every unrelated setting', async () => {
        const path = fixture.seedForeign(project());
        const connector = fixture.create(project());
        await connector.apply(await connector.plan(input()));

        const after = read(path);
        expect(fixture.serverNames(after)).toContain('their-server');
        expect(fixture.entry(after, 'their-server')?.command).toBe('their-binary');
        expect(fixture.unrelatedSetting(after)).toBe(true);
        expect(fixture.serverNames(after)).toContain(SERVER_NAME);
      });

      it('backs the file up before touching it', async () => {
        const path = fixture.seedForeign(project());
        const before = read(path);

        const connector = fixture.create(project());
        const receipt = await connector.apply(await connector.plan(input()));

        expect(receipt.backupPath).toBeDefined();
        expect(read(receipt.backupPath as string)).toBe(before);
      });

      it('marks the entry as ours, which is what makes disconnect precise', async () => {
        const connector = fixture.create(project());
        await connector.apply(await connector.plan(input()));

        expect((await connector.status(input())).ownedByLorepack).toBe(true);
      });

      it('uses an absolute project path and --ensure-current, as an argument array', async () => {
        const connector = fixture.create(project());
        const receipt = await connector.apply(await connector.plan(input()));
        const written = fixture.entry(read(receipt.configPath as string), SERVER_NAME);

        // An argument array rather than a concatenated string is what makes a path with a
        // space in it safe on every platform, which is the Windows quoting requirement.
        expect(Array.isArray(written?.args)).toBe(true);
        expect(written?.args).toContain('--ensure-current');
        expect(written?.args).toContain(project());
      });

      it('is idempotent, byte for byte, so re-running never accumulates anything', async () => {
        fixture.seedForeign(project());
        const connector = fixture.create(project());

        const first = await connector.apply(await connector.plan(input()));
        const once = read(first.configPath as string);
        await connector.apply(await connector.plan(input()));
        const twice = read(first.configPath as string);

        expect(fixture.serverNames(twice).filter((name) => name === SERVER_NAME)).toHaveLength(1);
        // Byte equality, ignoring only the ownership timestamp, which moves by design.
        expect(withoutTimestamps(twice)).toBe(withoutTimestamps(once));
      });
    });

    describe('removing', () => {
      it('takes back the Lorepack entry and leaves the rest', async () => {
        const path = fixture.seedForeign(project());
        const connector = fixture.create(project());
        const receipt = await connector.apply(await connector.plan(input()));
        await connector.remove(receipt);

        const after = read(path);
        expect(fixture.serverNames(after)).not.toContain(SERVER_NAME);
        expect(fixture.serverNames(after)).toContain('their-server');
        expect(fixture.unrelatedSetting(after)).toBe(true);
      });

      it('leaves an entry of the same name that someone else wrote', async () => {
        const path = fixture.seedImpostor(project());
        const before = read(path);

        await fixture.create(project()).remove(receiptFor(path));

        // Deleting it because the name matched is exactly the corruption the ownership marker
        // exists to prevent.
        expect(read(path)).toBe(before);
      });

      it('does nothing at all when there is no file', async () => {
        const connector = fixture.create(project());
        await expect(
          connector.remove(receiptFor(`${project()}/nothing-here.config`)),
        ).resolves.toBeUndefined();
      });
    });
  });
}

/** The one thing that legitimately differs between two runs. */
const withoutTimestamps = (text: string): string =>
  text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<when>');
