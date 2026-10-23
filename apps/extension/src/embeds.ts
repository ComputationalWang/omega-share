import { type AnyEmbed, canonicalizeEmbed, canonicalizeGenericEmbed, type Embed, MAX_POSITION_S } from "@omega/shared";

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

/**
 * A listed embed; generic embeds found in an iframe carry the frame's size so the popup can tell them apart.
 * Synced non-live embeds carry `startSeconds` when the page is part-way through (OME-1636): whole seconds, 1–MAX_POSITION_S.
 */
export type ListedEmbed = AnyEmbed & { readonly size?: FrameSize; readonly startSeconds?: number };

/** Whole seconds clamped to MAX_POSITION_S; undefined for anything under 1 second, NaN or not a number. */
function startSeconds(x: unknown): number | undefined {
  if (typeof x !== "number" || !(x >= 1)) return undefined;
  return Math.min(MAX_POSITION_S, Math.floor(x));
}

/** `90`, `90s`, `1m30s`, `1h2m3s`: the forms YouTube, Twitch and Vimeo put in a start param. */
const TIME_PARAM = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;

/** The start a provider URL carries: `t=` (YouTube, Twitch site), `start=` (YouTube embed), `time=` (Twitch player) or `#t=` (Vimeo). */
function urlStartSeconds(raw: string): number | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const q = url.searchParams;
  const value = q.get("t") ?? q.get("start") ?? q.get("time") ?? new URLSearchParams(url.hash.slice(1)).get("t");
  const match = value === null ? null : TIME_PARAM.exec(value);
  if (match === null) return undefined;
  const [, h = "0", m = "0", s = "0"] = match;
  return startSeconds(Number(h) * 3600 + Number(m) * 60 + Number(s));
}

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
  // The page's own <video> time belongs to the page URL (urls[0]) only, and beats its t=: the user has moved on since.
  const pageTime = startSeconds("currentTime" in scan ? scan.currentTime : undefined);
  for (const [i, c] of candidates("urls" in scan ? scan.urls : undefined).entries()) {
    const embed: Embed | null = canonicalizeEmbed(c);
    const live = embed !== null && embed.provider === "twitch" && embed.kind === "live";
    const start = embed === null || live ? undefined : ((i === 0 ? pageTime : undefined) ?? urlStartSeconds(c));
    add(embed === null || start === undefined ? embed : { ...embed, startSeconds: start });
  }
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
