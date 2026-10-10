/** How long the popup waits for the server before calling it unreachable (OME-836). */
export const ROOMS_TIMEOUT_MS = 8_000;
export const POST_TIMEOUT_MS = 10_000;

/** Rejects `withTimeout` when the server took too long; callers map it like a failed fetch. */
export class RequestTimeoutError extends Error {
  override readonly name = "RequestTimeoutError";
}

/**
 * Runs `request` with an abort signal that fires after `ms`, and rejects then even if the request ignores the signal.
 * The timer is always cleared, so nothing outlives the request.
 */
export async function withTimeout<T>(ms: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(`no answer within ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([request(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
