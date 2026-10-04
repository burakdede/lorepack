import { useCallback, useEffect, useState } from 'react';

/**
 * The reader's theme choice, and the theme it resolves to.
 *
 * `system` follows the operating system and keeps following it while the page is open. The
 * choice is a per-browser convenience, so it lives in `localStorage` and a browser that
 * refuses storage still gets a working page that follows the system. `index.html` applies
 * the same resolution before first paint; this hook keeps it current afterwards.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'lore-studio-theme';
const QUERY = '(prefers-color-scheme: dark)';

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage blocked: fall through to following the system.
  }
  return 'system';
}

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

function apply(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && prefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function useTheme(): {
  readonly choice: ThemeChoice;
  readonly setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setState] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    apply(choice);
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const follow = (): void => apply('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // The choice still applies for this page; it just will not be remembered.
    }
    setState(next);
  }, []);

  return { choice, setChoice };
}
