export async function withObserverDiagnostic<T>(
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!enabled) return operation();
  const original = process.env.LOREPACK_OBSERVER_DIAGNOSTIC;
  process.env.LOREPACK_OBSERVER_DIAGNOSTIC = '1';
  try {
    return await operation();
  } finally {
    if (original === undefined) delete process.env.LOREPACK_OBSERVER_DIAGNOSTIC;
    else process.env.LOREPACK_OBSERVER_DIAGNOSTIC = original;
  }
}
