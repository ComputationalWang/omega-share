import * as v from "valibot";
import { MAX_URL_LENGTH } from "./constants";

/** Providers we can embed and control (ADR 0002, ADR 0014). */
export const PROVIDERS = ["youtube", "twitch", "vimeo"] as const;
export type Provider = (typeof PROVIDERS)[number];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_EMBED_BASE = "https://www.youtube.com/embed/";
/** 11-char path segments YouTube uses for things that are not videos. */
const RESERVED_IDS = new Set(["videoseries", "live_stream"]);

export const YoutubeVideoIdSchema = v.pipe(
  v.string(),
  v.regex(YOUTUBE_ID),
  v.check((id) => !RESERVED_IDS.has(id), "reserved id"),
);

const TWITCH_PLAYER = "https://player.twitch.tv/";
/** First path segments on twitch.tv that are pages, not channels. */
const TWITCH_RESERVED = new Set([
  "directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops", "turbo", "prime", "friends",
  "messages", "search", "downloads", "jobs", "p", "store", "login", "signup", "logout", "broadcast", "moderator",
  "popout", "embed", "following", "u",
]);
/** Lowercase channel login. */
export const TwitchLoginSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9_]{1,25}$/),
  v.check((s) => !TWITCH_RESERVED.has(s), "reserved"),
);
/** VOD id without the player's `v` prefix. */
export const TwitchVodIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,11}$/));

const VIMEO_PLAYER = "https://player.vimeo.com/video/";
export const VimeoIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,11}$/));
/** Unlisted-video hash (`h=`), lowercase hex. */
export const VimeoHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{6,32}$/));

type TwitchIds = { kind: "live"; channel: string } | { kind: "vod"; videoId: string };

function twitchUrl(e: TwitchIds): string {
  return e.kind === "live" ? `${TWITCH_PLAYER}?channel=${e.channel}` : `${TWITCH_PLAYER}?video=v${e.videoId}`;
}

function vimeoUrl(id: string, hash: string | null): string {
  return hash === null ? VIMEO_PLAYER + id : `${VIMEO_PLAYER}${id}?h=${hash}`;
}

const CANONICAL = "url is not the canonical embed url";

/**
 * A validated embed. Every variant's `url` is rebuilt from its ids, so a parsed
 * Embed is safe to use as an iframe `src` (ADR 0003, ADR 0014).
 */
export const EmbedSchema = v.variant("provider", [
  v.pipe(
    v.object({ provider: v.literal("youtube"), videoId: YoutubeVideoIdSchema, url: v.string() }),
    v.check((e) => e.url === YOUTUBE_EMBED_BASE + e.videoId, CANONICAL),
  ),
  // The check sits on each object, not on the inner variant: `v.variant` recurses into a
  // nested variant's options directly and would skip a pipe on the variant itself.
  v.variant("kind", [
    v.pipe(
      v.object({ provider: v.literal("twitch"), kind: v.literal("live"), channel: TwitchLoginSchema, url: v.string() }),
      v.check((e) => e.url === twitchUrl(e), CANONICAL),
    ),
    v.pipe(
      v.object({ provider: v.literal("twitch"), kind: v.literal("vod"), videoId: TwitchVodIdSchema, url: v.string() }),
      v.check((e) => e.url === twitchUrl(e), CANONICAL),
    ),
  ]),
  v.pipe(
    v.object({ provider: v.literal("vimeo"), videoId: VimeoIdSchema, hash: v.nullable(VimeoHashSchema), url: v.string() }),
    v.check((e) => e.url === vimeoUrl(e.videoId, e.hash), CANONICAL),
  ),
]);
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

function youtubeEmbed(url: URL): Embed | null {
  const videoId = extractYoutubeId(url);
  if (videoId === null || !v.is(YoutubeVideoIdSchema, videoId)) return null;
  return { provider: "youtube", videoId, url: YOUTUBE_EMBED_BASE + videoId };
}

/** The single value of `name`, or null if it is absent or repeated. */
function onlyParam(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

const TWITCH_SITE_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);
const TWITCH_PLAYER_HOST = "player.twitch.tv";

function twitchEmbed(ids: TwitchIds): Embed | null {
  if (ids.kind === "live") {
    if (!v.is(TwitchLoginSchema, ids.channel)) return null;
    return { provider: "twitch", kind: "live", channel: ids.channel, url: twitchUrl(ids) };
  }
  if (!v.is(TwitchVodIdSchema, ids.videoId)) return null;
  return { provider: "twitch", kind: "vod", videoId: ids.videoId, url: twitchUrl(ids) };
}

/** Live channels and VODs only; clips and collections have no usable player API (ADR 0014). */
function extractTwitch(url: URL): TwitchIds | null {
  if (url.hostname === TWITCH_PLAYER_HOST) {
    if (url.pathname !== "/" || url.searchParams.has("collection")) return null;
    const hasChannel = url.searchParams.has("channel");
    if (hasChannel === url.searchParams.has("video")) return null; // neither, or ambiguous
    if (hasChannel) {
      const channel = onlyParam(url, "channel");
      return channel === null ? null : { kind: "live", channel: channel.toLowerCase() };
    }
    const video = onlyParam(url, "video");
    if (video === null) return null;
    return { kind: "vod", videoId: /^v/i.test(video) ? video.slice(1) : video };
  }
  if (!TWITCH_SITE_HOSTS.has(url.hostname)) return null;
  const vod = /^\/videos\/([^/]+)$/.exec(url.pathname);
  if (vod !== null) return { kind: "vod", videoId: vod[1] ?? "" };
  const live = /^\/([^/]+)\/?$/.exec(url.pathname);
  if (live !== null) return { kind: "live", channel: (live[1] ?? "").toLowerCase() };
  return null;
}

const VIMEO_SITE_HOSTS = new Set(["vimeo.com", "www.vimeo.com"]);
const VIMEO_PLAYER_HOST = "player.vimeo.com";
/** vimeo.com paths that name one video. Group 1 = id, group 2 = unlisted hash. */
const VIMEO_SITE_PATHS: readonly RegExp[] = [
  /^\/(\d+)(?:\/([^/]+))?$/,
  /^\/channels\/[^/]+\/(\d+)$/,
  /^\/groups\/[^/]+\/videos\/(\d+)$/,
  /^\/(?:album|showcase)\/[^/]+\/video\/(\d+)$/,
];

/** Public and unlisted videos only; live events are rejected (ADR 0014). */
function vimeoEmbed(url: URL): Embed | null {
  let id: string | undefined;
  let hash: string | null = null;
  if (url.hostname === VIMEO_PLAYER_HOST) {
    id = /^\/video\/(\d+)$/.exec(url.pathname)?.[1];
    if (url.searchParams.has("h")) {
      hash = onlyParam(url, "h");
      if (hash === null) return null;
    }
  } else if (VIMEO_SITE_HOSTS.has(url.hostname)) {
    for (const re of VIMEO_SITE_PATHS) {
      const m = re.exec(url.pathname);
      if (m === null) continue;
      id = m[1];
      hash = m[2] ?? null;
      break;
    }
  }
  if (id === undefined || !v.is(VimeoIdSchema, id)) return null;
  if (hash !== null) {
    hash = hash.toLowerCase();
    if (!v.is(VimeoHashSchema, hash)) return null;
  }
  return { provider: "vimeo", videoId: id, hash, url: vimeoUrl(id, hash) };
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

  const host = url.hostname;
  if (host === TWITCH_PLAYER_HOST || TWITCH_SITE_HOSTS.has(host)) {
    const ids = extractTwitch(url);
    return ids === null ? null : twitchEmbed(ids);
  }
  if (host === VIMEO_PLAYER_HOST || VIMEO_SITE_HOSTS.has(host)) return vimeoEmbed(url);
  return youtubeEmbed(url);
}
