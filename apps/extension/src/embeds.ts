import { type AnyEmbed, canonicalizeEmbed, canonicalizeGenericEmbed } from "@omega/shared";

/** Most candidate URLs we look at per tier from one page scan; the rest are ignored. */
export const MAX_CANDIDATES = 500;

/** The first `MAX_CANDIDATES` strings of `x` when it is an array; anything else is no candidates. */
function candidates(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, MAX_CANDIDATES).filter((c): c is string => typeof c === "string");
}

/**
 * Scan result → the embeds we can share, deduped by canonical URL in first-seen order:
 * synced embeds first (the contract's allowlist), then other `https:` iframe and
 * `<video>` sources that pass the shared generic validator (ADR 0024, not synced).
 * `ownHosts` (our server's host) and their subdomains are never generic: the server refuses those.
 * `scan` comes from the page, so anything not shaped like a `PageScan` is ignored.
 */
export function listEmbeds(scan: unknown, ownHosts: readonly string[] = []): AnyEmbed[] {
  if (typeof scan !== "object" || scan === null || Array.isArray(scan)) return [];
  const seen = new Map<string, AnyEmbed>();
  const add = (embed: AnyEmbed | null): void => {
    if (embed !== null && !seen.has(embed.url)) seen.set(embed.url, embed);
  };
  for (const c of candidates("urls" in scan ? scan.urls : undefined)) add(canonicalizeEmbed(c));
  // canonicalizeGenericEmbed rejects synced-provider hosts, so nothing is listed twice.
  for (const c of candidates("media" in scan ? scan.media : undefined)) add(canonicalizeGenericEmbed(c, { ownHosts }));
  return [...seen.values()];
}

export type ScanOutcome = { readonly kind: "embeds"; readonly embeds: AnyEmbed[] } | { readonly kind: "unreadable" };

/** The part of `chrome.scripting.InjectionResult` we read. */
export interface FrameResult {
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Runs the injected scan and tells "nothing supported here" apart from "we could not
 * read this tab" (chrome:// pages, the web store, no activeTab grant, a frame error).
 */
export async function scanTab(run: () => Promise<readonly FrameResult[]>, ownHosts: readonly string[] = []): Promise<ScanOutcome> {
  let frames: readonly FrameResult[];
  try {
    frames = await run();
  } catch {
    return { kind: "unreadable" };
  }
  const [top] = frames;
  if (top === undefined || top.error !== undefined) return { kind: "unreadable" };
  return { kind: "embeds", embeds: listEmbeds(top.result, ownHosts) };
}
