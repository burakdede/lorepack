import type { Scenario } from '../types.js';
import { CORPUS } from './corpus.js';

/**
 * What an AI client does with Lorepack.
 *
 * The scenario a person cannot check by reading output: a coding agent launches
 * `lore mcp`, and the first thing it does is ask what tools exist. Everything here is
 * invisible to every other scenario, because it happens over a protocol rather than on a
 * terminal.
 */
export const MCP_SCENARIOS: readonly Scenario[] = [
  {
    id: 'mcp/a-client-connects-and-lists-tools',
    title: 'An AI client launches `lore mcp` and finds the tools',
    proves: 'Section 14.1 and 14.3: the tool surface is served, and stdout carries protocol only.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init'] },
    steps: [
      {
        action: 'protocol',
        args: ['mcp', '--ensure-current'],
        method: 'tools/list',
        describe:
          'Launch the server against a project with no build yet, and ask for the tool list',
        expectResult: [
          'lore_build_info',
          'lore_search',
          'lore_context_for_task',
          'lore_read_source',
        ],
        // The build happened, and it said so on the stream diagnostics belong on.
        expectStderr: ['Building'],
      },
    ],
  },
  {
    id: 'mcp/the-server-answers-the-mandatory-version-probe',
    title: 'A modern client asks `lore mcp` which protocol revisions it supports',
    proves:
      'Section 14.3: `server/discover` is a MUST, and the stdio transport negotiates the same revision the HTTP one does.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'protocol',
        args: ['mcp', '--active-only'],
        method: 'server/discover',
        describe: 'Send the probe a negotiating client sends before anything else',
        // The revision, and the identity the spec says a result SHOULD carry.
        expectResult: ['supportedVersions', '2026-07-28', 'lorepack'],
      },
    ],
  },
  {
    id: 'mcp/a-task-comes-back-cited',
    title: 'A task asked over MCP comes back with citations',
    proves: 'Section 13.3 and 10.8: a bundle is bounded, cited, and carries its build id.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'protocol',
        args: ['mcp', '--active-only'],
        method: 'tools/call',
        params: {
          name: 'lore_context_for_task',
          arguments: { task: 'how do I roll back a release' },
        },
        describe: 'Ask for context the way an agent does, over the protocol',
        expectResult: ['citations', 'relativePath', 'lore_'],
      },
    ],
  },

  {
    id: 'mcp/export-is-one-file-a-person-can-paste',
    title: '`lore export` writes a bounded, cited file for a chat product',
    proves: 'Section 14.6: the compatibility bridge for clients that cannot speak MCP.',
    mode: 'auto',
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'run',
        args: ['export', '--task', 'how do I roll back a release'],
        describe: 'Export to stdout, which is what a redirect captures',
        expect: {
          exitCode: 0,
          stdout: {
            contains: [
              '# Context for: how do I roll back a release',
              'Profile **chat**',
              '## Citations',
              '## What was left out',
              'no claim about which document is correct',
            ],
          },
        },
      },
      {
        action: 'run',
        args: ['export', '--task', 'rollback', '--format', 'json'],
        json: true,
        describe: 'And as the serialized bundle, for a program',
        expect: { exitCode: 0, json: [{ path: 'citations[0].relativePath', exists: true }] },
      },
      {
        action: 'run',
        args: ['export'],
        describe: 'An export without a task says so',
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_INVALID_ARGUMENT',
          stderr: { contains: ['--task'] },
        },
      },
      {
        action: 'run',
        args: ['export', '--task', 'rollback', '--budget', '400'],
        describe: 'A budget far outside the supported range is refused, and says how to mean it',
        expect: {
          exitCode: 1,
          errorCode: 'LORE_E_INVALID_ARGUMENT',
          stderr: { contains: ['4,000 to 40,000', '--allow-unsupported-budget'] },
        },
      },
      {
        action: 'run',
        args: ['export', '--task', 'rollback', '--budget', '400', '--allow-unsupported-budget'],
        describe: 'And is honoured once it is deliberate',
        expect: { exitCode: 0, stdout: { contains: ['budget 400 estimated tokens'] } },
      },
    ],
  },

  {
    id: 'mcp/every-documented-resource-is-served',
    title: 'A client browsing resources finds every URI section 14.2 names',
    proves: 'Section 14.2: the resource surface, including the diff between two builds.',
    mode: 'auto',
    regression: 185,
    fixture: { files: CORPUS, setup: ['init', 'build'] },
    steps: [
      {
        action: 'protocol',
        args: ['mcp', '--active-only'],
        method: 'resources/list',
        describe: 'Ask for the fixed resources',
        expectResult: ['lore://project/build', 'lore://project/sources', 'lore://project/tables'],
      },
      {
        action: 'protocol',
        args: ['mcp', '--active-only'],
        method: 'resources/templates/list',
        describe: 'And the templated ones, which is where a diff of two builds lives',
        expectResult: ['lore://source/{artifactId}', 'lore://build/{buildId}/diff/{otherBuildId}'],
      },
    ],
  },
];
