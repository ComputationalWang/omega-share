/** Logged-out Twitch eligibility is upstream and independent for each viewer. */
export interface LiveProbe {
  readonly frameUrl: string | null;
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

/** Select only a simultaneously eligible ungated pair; a gate never counts as an advertisement. */
export async function discoverPairedLive<T extends LiveProbe>(candidates: readonly string[], deps: Discovery<T>, perChannel = 25_000, budget = 120_000): Promise<{
  channel: string | null;
  tried: { channel: string; outcome: Outcome; viewers: [T, T] }[];
}> {
  const tried: { channel: string; outcome: Outcome; viewers: [T, T] }[] = [];
  const start = deps.now();
  for (const channel of candidates) {
    if (deps.now() - start >= budget) break;
    await deps.share(channel);
    const t0 = deps.now();
    let viewers = await deps.observe(channel);
    let outcome: Outcome = "no-start";
    while (deps.now() - t0 < perChannel && deps.now() - start < budget) {
      if (viewers.some((v) => v.frameUrl !== null && v.error !== null && v.error.reason !== "offline")) { outcome = "error"; break; }
      // A previous candidate's stale room error alone cannot establish an offline player.
      if (viewers.some((v) => v.frameUrl !== null && v.error?.reason === "offline" && v.media !== null && /offline/i.test(v.media.overlay))) { outcome = "offline"; break; }
      if (viewers.some((v) => v.gate)) break;
      if (viewers.every((v) => v.frameUrl !== null && v.error === null && v.media !== null && (v.media.ad || (!v.media.paused && v.media.currentTime > 0.5)))) {
        outcome = "live";
        break;
      }
      await deps.pause();
      viewers = await deps.observe(channel);
    }
    tried.push({ channel, outcome, viewers });
    if (outcome === "live") return { channel, tried };
  }
  return { channel: null, tried };
}
