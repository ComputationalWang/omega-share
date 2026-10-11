/** Logged-out Twitch eligibility is upstream and independent for each viewer. */
export interface LiveProbe {
  readonly gate: boolean;
  readonly reason: string;
  readonly media: { readonly ad: boolean; readonly paused: boolean; readonly currentTime: number; readonly overlay: string } | null;
  readonly error: { readonly reason: string } | null;
}

interface Discovery<T extends LiveProbe> {
  share(channel: string): Promise<void>;
  observe(channel: string): Promise<[T, T]>;
  now(): number;
  pause(): Promise<void>;
}

type Outcome = "live" | "offline" | "error" | "no-start";

/** Extracted M2 discovery policy, with injectable observations and clock for regression tests. */
export async function discoverPairedLive<T extends LiveProbe>(candidates: readonly string[], deps: Discovery<T>, perChannel = 25_000, budget = 120_000): Promise<{
  channel: string | null;
  tried: { channel: string; outcome: Outcome; viewers: [T, T] }[];
}> {
  const tried: { channel: string; outcome: Outcome; viewers: [T, T] }[] = [];
  const start = deps.now();
  for (const channel of candidates) {
    if (deps.now() - start > budget) break;
    await deps.share(channel);
    const t0 = deps.now();
    let viewers = await deps.observe(channel);
    let outcome: Outcome = "no-start";
    while (deps.now() - t0 < perChannel) {
      const { media: s, error } = viewers[0];
      if (error !== null && error.reason !== "offline") { outcome = "error"; break; }
      if (error?.reason === "offline" && s !== null && /offline/i.test(s.overlay)) { outcome = "offline"; break; }
      if (s !== null && (s.ad || (!s.paused && s.currentTime > 0.5))) { outcome = "live"; break; }
      await deps.pause();
      viewers = await deps.observe(channel);
    }
    tried.push({ channel, outcome, viewers });
    if (outcome === "live") return { channel, tried };
  }
  return { channel: null, tried };
}
