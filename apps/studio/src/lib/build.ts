import { useQuery } from '@tanstack/react-query';
import { client } from './api.js';

/** The shell polls this query, and every build-derived route observes the same id. */
export function useActiveBuild() {
  return useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
  });
}
