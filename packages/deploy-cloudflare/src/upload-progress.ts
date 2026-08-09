export async function withProgressHeartbeat<T>(
  intervalMs: number,
  emit: () => void,
  work: () => Promise<T>,
): Promise<T> {
  if (intervalMs <= 0) {
    return await work();
  }

  const timer = setInterval(() => {
    emit();
  }, intervalMs);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
