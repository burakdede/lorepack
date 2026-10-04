import { useEffect, useState } from 'react';

/**
 * One query parameter from the hash, such as `artifact` in `#/sources?artifact=a1`.
 *
 * Read from `window.location` rather than through the router, so a route still renders on
 * its own in a component test with no router around it. The command palette uses these to
 * open a route on one source or one table.
 *
 * The router moves between hashes with `pushState`, which fires no event, so whoever
 * navigates calls `announceLocation()` afterwards.
 */
const EVENT = 'lore:locationchange';

function read(name: string): string | null {
  const hash = window.location.hash;
  const query = hash.indexOf('?');
  if (query === -1) return null;
  return new URLSearchParams(hash.slice(query + 1)).get(name);
}

export function announceLocation(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useHashParam(name: string): string | null {
  const [value, setValue] = useState(() => read(name));

  useEffect(() => {
    const update = (): void => setValue(read(name));
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, [name]);

  return value;
}
