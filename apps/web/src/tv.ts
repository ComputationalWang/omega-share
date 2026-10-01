import * as v from "valibot";
import { EmbedSchema, GenericEmbedSchema, normalizeHostname, type Embed } from "@omega/shared";

/** An iframe the site builds itself (YouTube, Vimeo). */
export interface TvIframe {
  readonly kind: "iframe";
  /** Changes whenever the rendered frame would. */
  readonly key: string;
  readonly src: string;
  readonly sandbox: string;
  readonly allow: string;
  readonly referrerPolicy: ReferrerPolicy;
}

/** Options for `new Twitch.Player(container, options)`. Every key becomes a query parameter of the SDK's iframe. */
export type TwitchPlayerOptions = { readonly channel: string; readonly video?: never } | { readonly video: string; readonly channel?: never };
export type TwitchOptions = TwitchPlayerOptions & {
  readonly parent: readonly string[];
  readonly width: "100%";
  readonly height: "100%";
  readonly autoplay: true;
  readonly muted: false;
};

/** Twitch: the SDK builds the iframe from these frozen options, and the adapter checks it (ADR 0014 §5). */
export interface TvTwitch {
  readonly kind: "twitch";
  readonly key: string;
  readonly options: TwitchOptions;
}

export type TvFrame = TvIframe | TvTwitch;

/** The generic tier's iframe (ADR 0024 §2b): every attribute is a constant except `src` and the host in `title`. */
export interface TvGeneric {
  readonly kind: "generic";
  readonly key: string;
  /** Punycode hostname, shown on the load card as text. */
  readonly host: string;
  readonly src: string;
  readonly sandbox: string;
  readonly allow: string;
  readonly referrerPolicy: ReferrerPolicy;
  readonly title: string;
}

/** The iframe host we render (ADR 0011). The wire `Embed.url` stays canonical `www.youtube.com`. */
export const NOCOOKIE_ORIGIN = "https://www.youtube-nocookie.com";
/** Flip to false to fall back to the canonical host if the IFrame API stops attaching to nocookie. */
export const USE_NOCOOKIE = true;
export const TWITCH_PLAYER_ORIGIN = "https://player.twitch.tv";

/**
 * Scripts + same-origin are the minimum the players run with. Popups let the
 * player's own logo/title/ad links open a new tab (ADR 0011). No forms, modals or top navigation.
 */
const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
const YOUTUBE_ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";
const VIMEO_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";
/** Fixed Vimeo player parameters (ADR 0014 §5, research §2.2): no analytics, no autopause by other players, no chrome. */
const VIMEO_PARAMS: readonly (readonly [string, string])[] = [
  ["dnt", "1"],
  ["autopause", "0"],
  ["autoplay", "1"],
  ["keyboard", "0"],
  ["controls", "0"],
  ["title", "0"],
  ["byline", "0"],
  ["portrait", "0"],
];
/** No popups, no top navigation, no forms or modals (ADR 0024 §2b). */
const GENERIC_SANDBOX = "allow-scripts allow-same-origin allow-presentation";
/** Load is the viewer saying "play this"; no encrypted-media (ADR 0024 §2b). */
const GENERIC_ALLOW = "fullscreen; autoplay";
/** Twitch query keys that pick the content; exactly one of them may appear, once. */
const TWITCH_CONTENT_KEYS = ["channel", "video", "collection"] as const;

/**
 * The only place the site decides what an embed frame is: `embed` must parse as a
 * canonical allowlisted embed (ADR 0002/0003), otherwise nothing renders. Everything
 * is derived from the parsed ids plus constants. `pageOrigin` is this page's origin
 * (YouTube talks back to it; Twitch's `parent` is its host).
 */
export function tvFrame(embed: unknown, pageOrigin: string = location.origin, nocookie: boolean = USE_NOCOOKIE): TvFrame | null {
  const r = v.safeParse(EmbedSchema, embed);
  if (!r.success) return null;
  const page = httpOrigin(pageOrigin);
  if (page === null) return null;
  const e = r.output;
  switch (e.provider) {
    case "youtube":
      return youtubeFrame(e.url, page.origin, nocookie);
    case "vimeo":
      return vimeoFrame(e.url);
    case "twitch":
      return twitchFrame(e, page.hostname);
  }
}

/**
 * The only place a generic embed becomes a frame: `embed` must parse as a canonical
 * `GenericEmbed`, and its host must not be this page's host (`pageHost`) or under it,
 * which the schema can't know. Otherwise null.
 */
export function genericFrame(embed: unknown, pageHost: string = location.hostname): TvGeneric | null {
  const r = v.safeParse(GenericEmbedSchema, embed);
  if (!r.success) return null;
  const { host, url } = r.output;
  const own = normalizeHostname(pageHost);
  if (own === null || host === own || host.endsWith(`.${own}`)) return null;
  return { kind: "generic", key: url, host, src: url, sandbox: GENERIC_SANDBOX, allow: GENERIC_ALLOW, referrerPolicy: "no-referrer", title: `Shared video from ${host}` };
}

function youtubeFrame(url: string, origin: string, nocookie: boolean): TvIframe {
  const src = new URL(url);
  if (nocookie) {
    const nc = new URL(NOCOOKIE_ORIGIN);
    src.protocol = nc.protocol;
    src.host = nc.host;
  }
  const q = src.searchParams;
  q.set("enablejsapi", "1");
  q.set("origin", origin);
  q.set("controls", "0");
  q.set("disablekb", "1");
  q.set("playsinline", "1");
  q.set("rel", "0");
  q.set("autoplay", "1");
  // YouTube refuses to play embeds without a referrer, so don't use no-referrer.
  return { kind: "iframe", key: src.href, src: src.href, sandbox: SANDBOX, allow: YOUTUBE_ALLOW, referrerPolicy: "strict-origin-when-cross-origin" };
}

function vimeoFrame(url: string): TvIframe {
  // The canonical url is the player URL, with `?h=<hash>` for unlisted videos; ours go after it.
  const src = new URL(url);
  for (const [k, val] of VIMEO_PARAMS) src.searchParams.append(k, val);
  // Vimeo's own oEmbed markup uses this policy; its domain-level privacy check reads the referrer's origin.
  return { kind: "iframe", key: src.href, src: src.href, sandbox: SANDBOX, allow: VIMEO_ALLOW, referrerPolicy: "strict-origin-when-cross-origin" };
}

function twitchFrame(e: Extract<Embed, { provider: "twitch" }>, host: string): TvTwitch {
  const content: TwitchPlayerOptions = e.kind === "live" ? { channel: e.channel } : { video: `v${e.videoId}` };
  const options: TwitchOptions = Object.freeze({ ...content, parent: Object.freeze([host]), width: "100%", height: "100%", autoplay: true, muted: false } as const);
  return { kind: "twitch", key: `${e.url}#parent=${host}`, options };
}

/**
 * The post-render check on the iframe the Twitch SDK built (research §4.1 W1): exactly the
 * player origin, the one content parameter equal to ours, and `parent` = this page's host only.
 * Anything else → remove it. Attributes (sandbox, allow) are the SDK's, accepted in ADR 0014 §5.
 */
export function twitchIframeMatches(src: string, frame: TvTwitch): boolean {
  if (!URL.canParse(src)) return false;
  const u = new URL(src);
  if (u.origin !== TWITCH_PLAYER_ORIGIN) return false;
  const want = frame.options.channel !== undefined ? (["channel", frame.options.channel] as const) : (["video", frame.options.video] as const);
  for (const k of TWITCH_CONTENT_KEYS) {
    const got = u.searchParams.getAll(k);
    if (k === want[0] ? got.length !== 1 || got[0] !== want[1] : got.length !== 0) return false;
  }
  const parents = u.searchParams.getAll("parent");
  return parents.length === frame.options.parent.length && parents.every((p, i) => p === frame.options.parent[i]);
}

function httpOrigin(s: string): URL | null {
  if (!URL.canParse(s)) return null;
  const u = new URL(s);
  return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}
