/** `load`, run once (OME-1495): callers share its promise; a failed load is forgotten, so the next call retries. */
export function onceAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
}
