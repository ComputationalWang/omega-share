/** Availability is upstream and per viewer: only a pair gated in the same observation is usable. */
export interface GateProbe { readonly gate: boolean; readonly reason: string }

interface Discovery<T extends GateProbe> {
  share(channel: string): Promise<void>;
  observe(channel: string): Promise<[T, T]>;
  now(): number;
  pause(): Promise<void>;
}

export async function discoverPairedGate<T extends GateProbe>(candidates: readonly string[], deps: Discovery<T>, timeoutMs = 15_000): Promise<{
  channel: string | null;
  tried: { channel: string; outcome: "gated" | "unavailable"; viewers: [T, T] }[];
}> {
  const tried: { channel: string; outcome: "gated" | "unavailable"; viewers: [T, T] }[] = [];
  for (const channel of candidates.slice(0, 8)) {
    await deps.share(channel);
    const started = deps.now();
    let viewers = await deps.observe(channel);
    while (!viewers.every((v) => v.gate) && deps.now() - started < timeoutMs) {
      await deps.pause();
      viewers = await deps.observe(channel);
    }
    const outcome = viewers.every((v) => v.gate) ? "gated" : "unavailable";
    tried.push({ channel, outcome, viewers });
    if (outcome === "gated") return { channel, tried };
  }
  return { channel: null, tried };
}

/** Failure evidence is best effort: a detached viewer must not hide another viewer or the original failure. */
export async function collectGateEvidence(tasks: Record<string, () => Promise<unknown>>, timeoutMs = 10_000): Promise<Record<string, { value?: unknown; error?: string }>> {
  const results: Record<string, { value?: unknown; error?: string }> = {};
  await Promise.all(Object.entries(tasks).map(async ([name, task]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`${name}: capture timed out after ${String(timeoutMs)} ms`)); }, timeoutMs);
      });
      results[name] = { value: await Promise.race([task(), deadline]) };
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }));
  return results;
}
