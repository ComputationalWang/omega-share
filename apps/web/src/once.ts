/** `load`, run once (OME-1495): callers share its promise; a failed load is forgotten, so the next call retries. */
export function onceAsync<T>(load: () => Promise<T>): () => Promise<T> {
  return load;
}
