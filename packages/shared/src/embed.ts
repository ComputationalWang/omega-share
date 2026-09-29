import * as v from "valibot";

/** Longest input URL we will even try to parse. */
export const MAX_URL_LENGTH = 2048;

/** Providers we can embed and control (ADR 0002). YouTube only for now. */
export const PROVIDERS = ["youtube"] as const;
export type Provider = (typeof PROVIDERS)[number];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_EMBED_BASE = "https://www.youtube.com/embed/";
/** 11-char path segments YouTube uses for things that are not videos. */
const RESERVED_IDS = new Set(["videoseries"]);

export const YoutubeVideoIdSchema = v.pipe(
  v.string(),
  v.regex(YOUTUBE_ID),
  v.check((id) => !RESERVED_IDS.has(id), "reserved id"),
);

/**
 * A validated embed. `url` is always the canonical form rebuilt from `videoId`,
 * so a parsed Embed is safe to use as an iframe `src`.
 */
export const EmbedSchema = v.pipe(
  v.object({
    provider: v.picklist(PROVIDERS),
    videoId: YoutubeVideoIdSchema,
    url: v.string(),
  }),
  v.check((e) => e.url === YOUTUBE_EMBED_BASE + e.videoId, "url is not the canonical embed url"),
);
export type Embed = v.InferOutput<typeof EmbedSchema>;

/** Host → how the video id is found in that host's URLs. */
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const EMBED_HOSTS = new Set([...WATCH_HOSTS, "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOST = "youtu.be";

function extractYoutubeId(url: URL): string | null {
  const host = url.hostname;
  const path = url.pathname;
  if (host === SHORT_HOST) return path.slice(1);
  if (WATCH_HOSTS.has(host) && path === "/watch") {
    const ids = url.searchParams.getAll("v");
    return ids.length === 1 ? (ids[0] ?? null) : null;
  }
  if (EMBED_HOSTS.has(host) && path.startsWith("/embed/")) return path.slice("/embed/".length);
  return null;
}

/**
 * Turn a supported video URL into its canonical embed, or null if the URL is not
 * on the provider allowlist. Pure; never throws.
 */
export function canonicalizeEmbed(input: string): Embed | null {
  if (input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;

  const videoId = extractYoutubeId(url);
  if (videoId === null || !v.is(YoutubeVideoIdSchema, videoId)) return null;
  return { provider: "youtube", videoId, url: YOUTUBE_EMBED_BASE + videoId };
}
