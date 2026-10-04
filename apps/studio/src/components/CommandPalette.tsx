import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { client, fetchSources } from '../lib/api.js';
import type { ThemeChoice } from '../lib/theme.js';
import { Icon, type IconName } from './Icon.js';
import './CommandPalette.css';

/**
 * The index of everything Studio can open: routes, every indexed source, every table, and
 * the few actions that are not tied to a page.
 *
 * Mounted only while open, so its queries run when someone asks rather than on every page.
 * It shares query keys with the routes, so opening it on Sources costs nothing.
 *
 * A combobox over a listbox (WAI-ARIA APG): focus stays in the input, arrows move the active
 * option, Enter runs it, Escape closes and returns focus to whatever opened it.
 */

export interface PaletteRoute {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

interface Entry {
  readonly id: string;
  readonly group: (typeof GROUPS)[number];
  readonly label: string;
  readonly detail?: string;
  readonly icon: IconName;
  readonly run: () => void;
}

const MAX_PER_GROUP = 8;
const GROUPS = ['Go to', 'Sources', 'Tables', 'Actions'] as const;

export function CommandPalette({
  routes,
  hasTables,
  buildId,
  onNavigate,
  onTheme,
  onClose,
}: {
  readonly routes: readonly PaletteRoute[];
  readonly hasTables: boolean;
  readonly buildId: string | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onTheme: (choice: ThemeChoice) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const sources = useQuery({ queryKey: ['sources'], queryFn: fetchSources });
  const tables = useQuery({
    queryKey: ['tables'],
    queryFn: ({ signal }) => client.listTables(signal),
    enabled: hasTables,
  });

  useEffect(() => {
    input.current?.focus();
  }, []);

  const entries = useMemo((): Entry[] => {
    const all: Entry[] = [
      ...routes.map(
        (route): Entry => ({
          id: `route:${route.to}`,
          group: 'Go to',
          label: route.label,
          icon: route.icon,
          run: () => onNavigate(route.to),
        }),
      ),
      ...(sources.data?.artifacts ?? []).map(
        (artifact): Entry => ({
          id: `source:${artifact.artifactId}`,
          group: 'Sources',
          label: artifact.displayPath,
          detail: `${artifact.chunkCount} ${artifact.chunkCount === 1 ? 'chunk' : 'chunks'}`,
          icon: 'sources',
          run: () => onNavigate(`/sources?artifact=${encodeURIComponent(artifact.artifactId)}`),
        }),
      ),
      ...(tables.data?.tables ?? []).map(
        (table): Entry => ({
          id: `table:${table.tableId}`,
          group: 'Tables',
          label: table.name,
          icon: 'tables',
          run: () => onNavigate(`/tables?table=${encodeURIComponent(table.tableId)}`),
        }),
      ),
      ...(buildId === undefined
        ? []
        : [
            {
              id: 'action:copy-build',
              group: 'Actions',
              label: 'Copy active build id',
              detail: buildId.slice(0, 17),
              icon: 'copy',
              run: () => void navigator.clipboard?.writeText(buildId),
            } satisfies Entry,
          ]),
      ...(['system', 'light', 'dark'] as const).map(
        (choice): Entry => ({
          id: `theme:${choice}`,
          group: 'Actions',
          label: `Use ${choice} theme`,
          icon: choice,
          run: () => onTheme(choice),
        }),
      ),
    ];

    const needle = query.trim().toLowerCase();
    const matched = needle === '' ? all : all.filter((entry) => matches(entry, needle));
    // Capped per group, so a build with 2,500 sources cannot bury the routes and actions.
    const counts = new Map<string, number>();
    return matched.filter((entry) => {
      const seen = counts.get(entry.group) ?? 0;
      counts.set(entry.group, seen + 1);
      return seen < MAX_PER_GROUP;
    });
  }, [routes, sources.data, tables.data, buildId, query, onNavigate, onTheme]);

  // A new query starts at the top, rather than leaving the highlight on a row that moved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the query only
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (entry: Entry | undefined): void => {
    if (entry === undefined) return;
    onClose();
    entry.run();
  };

  const optionId = (index: number): string => `${listId}-option-${index}`;
  const groups = GROUPS.map((group) => ({
    group,
    rows: entries.flatMap((entry, index) => (entry.group === group ? [{ entry, index }] : [])),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="palette-layer">
      <button
        type="button"
        className="palette-scrim"
        aria-label="Close the command palette"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-search">
          <Icon name="search" />
          <input
            ref={input}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={entries.length > 0 ? optionId(active) : undefined}
            aria-label="Search routes, sources, tables and actions"
            placeholder="Jump to a route, source or table"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, entries.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(entries[active]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'Tab') {
                // The input is the only stop in the dialog; Tab must not walk out of it.
                event.preventDefault();
              }
            }}
          />
          <kbd className="kbd">esc</kbd>
        </div>

        <div className="palette-list" id={listId} role="listbox" ref={list} aria-label="Results">
          {entries.length === 0 && (
            <p className="palette-empty">
              {sources.isPending ? 'Reading sources.' : `Nothing matches "${query.trim()}".`}
            </p>
          )}
          {groups.map(({ group, rows }) => (
            // A listbox group, which has no native element: a fieldset groups form controls.
            // biome-ignore lint/a11y/useSemanticElements: ARIA listbox option group
            <div key={group} role="group" aria-labelledby={`${listId}-${group}`}>
              <div className="palette-group" id={`${listId}-${group}`}>
                {group}
              </div>
              {rows.map(({ entry, index }) => (
                // Options are never focused: focus stays in the input and
                // `aria-activedescendant` points here, so the keyboard path is the input's
                // own key handler. The click is the pointer path to the same choice.
                // biome-ignore lint/a11y/useFocusableInteractive: active-descendant listbox option
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input
                <div
                  key={entry.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={
                    index === active ? 'palette-option palette-option-on' : 'palette-option'
                  }
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(entry)}
                >
                  <Icon name={entry.icon} />
                  <span className="palette-label">{entry.label}</span>
                  {entry.detail !== undefined && (
                    <span className="palette-detail">{entry.detail}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}

function matches(entry: Entry, needle: string): boolean {
  const haystack = `${entry.label} ${entry.group}`.toLowerCase();
  // Every word must appear, in any order, so "eng auth" finds `context/engineering/auth.md`.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}
