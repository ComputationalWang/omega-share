import { type AnyEmbed, canonicalizeEmbed, canonicalizeGenericEmbed } from "@omega/shared";

/** Most candidate URLs we look at per tier from one page scan; the rest are ignored. */
const MAX_CANDIDATES = 500;

/** Smaller frames are widgets, trackers or ads, not the video (OME-1037). */
export const MIN_FRAME_WIDTH = 200;
export const MIN_FRAME_HEIGHT = 120;

/** Ad and SDK hosts (and their subdomains) whose frames are never the video (OME-1071: IMA bridges on theverge.com). */
export const AD_FRAME_HOSTS: readonly string[] = ["imasdk.googleapis.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagservices.com"];

const isAdHost = (host: string): boolean => AD_FRAME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** A frame's rendered size in CSS px. */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** A listed embed; generic embeds found in an iframe carry the frame's size so the popup can tell them apart. */
export type ListedEmbed = AnyEmbed & { readonly size?: FrameSize };

/** The first `MAX_CANDIDATES` strings of `x` when it is an array; anything else is no candidates. */
function candidates(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, MAX_CANDIDATES).filter((c): c is string => typeof c === "string");
}

/** Frames of at least `MIN_FRAME_WIDTH`×`MIN_FRAME_HEIGHT`, largest area first (page order on ties); malformed entries are skipped. */
function frameCandidates(x: unknown): { url: string; size: FrameSize }[] {
  if (!Array.isArray(x)) return [];
  const frames: { url: string; size: FrameSize }[] = [];
  for (const f of x.slice(0, MAX_CANDIDATES) as unknown[]) {
    if (typeof f !== "object" || f === null || !("url" in f && "width" in f && "height" in f)) continue;
    const { url, width, height } = f;
    if (typeof url !== "string" || typeof width !== "number" || typeof height !== "number") continue;
    if (width >= MIN_FRAME_WIDTH && height >= MIN_FRAME_HEIGHT) frames.push({ url, size: { width, height } });
  }
  return frames.sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height);
}

/**
 * Scan result → the embeds we can share, deduped by canonical URL in first-seen order:
 * synced embeds first in page order (the contract's allowlist), then other `https:` sources
 * that pass the shared generic validator (ADR 0024, not synced), most likely video first:
 * `<video>` sources, then iframes largest first, tiny and hidden ones dropped (OME-1037).
 * Known ad and SDK hosts (`AD_FRAME_HOSTS`) are never generic either.
 * `ownHosts` (our server's host) and their subdomains are never generic: the server refuses those.
 * `scan` comes from the page, so anything not shaped like a `PageScan` is ignored.
 */
export function listEmbeds(scan: unknown, ownHosts: readonly string[] = []): ListedEmbed[] {
  if (typeof scan !== "object" || scan === null || Array.isArray(scan)) return [];
  const seen = new Map<string, ListedEmbed>();
  const add = (embed: ListedEmbed | null): void => {
    if (embed === null || seen.has(embed.url) || (embed.provider === "generic" && isAdHost(embed.host))) return;
    seen.set(embed.url, embed);
  };
  for (const c of candidates("urls" in scan ? scan.urls : undefined)) add(canonicalizeEmbed(c));
  // canonicalizeGenericEmbed rejects synced-provider hosts, so nothing is listed twice.
  for (const c of candidates("media" in scan ? scan.media : undefined)) add(canonicalizeGenericEmbed(c, { ownHosts }));
  for (const { url, size } of frameCandidates("frames" in scan ? scan.frames : undefined)) {
    const embed = canonicalizeGenericEmbed(url, { ownHosts });
    add(embed === null ? null : { ...embed, size });
  }
  return [...seen.values()];
}

export type ScanOutcome = { readonly kind: "embeds"; readonly embeds: ListedEmbed[] } | { readonly kind: "unreadable" };

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
