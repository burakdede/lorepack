import { LoreError } from '@lorepack/core';

export type CompletionValueKind =
  | 'value'
  | 'path'
  | 'build'
  | 'client'
  | 'target'
  | 'config-subject'
  | 'extension';

export interface CompletionContext {
  readonly cwd: string;
  readonly words: readonly string[];
  readonly currentWord: string;
  readonly signal?: AbortSignal;
}

export type CompletionProvider = (
  context: CompletionContext,
) => readonly string[] | Promise<readonly string[]>;

export interface CommandArgumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly valueKind?: CompletionValueKind;
  readonly values?: readonly string[];
  readonly complete?: CompletionProvider;
}

export interface CommandFlagDefinition {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: unknown;
  readonly valueKind?: CompletionValueKind;
  readonly values?: readonly string[];
  readonly complete?: CompletionProvider;
}

export interface CommandExample {
  readonly command: string;
  readonly description?: string;
}

export interface CommandMetadata {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly CommandArgumentDefinition[];
  readonly flags?: readonly CommandFlagDefinition[];
  readonly aliases?: readonly string[];
  readonly examples?: readonly CommandExample[];
}

export function validateCommandMetadata(definitions: readonly CommandMetadata[]): void {
  const names = new Set<string>();
  const aliases = new Set<string>();

  for (const definition of definitions) {
    if (definition.name.trim() === '') {
      throw metadataError('A command name cannot be empty.');
    }
    if (names.has(definition.name)) {
      throw metadataError(`Duplicate command name: ${definition.name}.`);
    }
    names.add(definition.name);

    for (const alias of definition.aliases ?? []) {
      if (alias.trim() === '') {
        throw metadataError(`Empty alias for command ${definition.name}.`);
      }
      if (alias === definition.name || names.has(alias) || aliases.has(alias)) {
        throw metadataError(`Duplicate command or alias: ${alias}.`);
      }
      aliases.add(alias);
    }

    const flagNames = new Set<string>();
    for (const flag of definition.flags ?? []) {
      const parsed = flag.flags.match(/--?[a-zA-Z0-9][a-zA-Z0-9-]*/g) ?? [];
      if (parsed.length === 0) {
        throw metadataError(`Invalid flag declaration: ${flag.flags}.`);
      }
      for (const name of parsed) {
        if (flagNames.has(name)) {
          throw metadataError(`Duplicate flag ${name} on ${definition.name}.`);
        }
        flagNames.add(name);
      }
    }
  }

  for (const name of names) {
    if (aliases.has(name)) {
      throw metadataError(`Command name is also an alias: ${name}.`);
    }
  }
}

function metadataError(message: string): LoreError {
  return new LoreError('LORE_E_INTERNAL', message, {
    remediation: 'Fix the registered command metadata before starting the CLI.',
  });
}
