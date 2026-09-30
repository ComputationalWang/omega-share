import * as v from "valibot";
import { EmbedSchema } from "@omega/shared";

export interface TvFrame {
  readonly src: string;
  readonly sandbox: string;
  readonly allow: string;
  readonly referrerPolicy: ReferrerPolicy;
}

/** The iframe host we render (ADR 0011). The wire `Embed.url` stays canonical `www.youtube.com`. */
export const NOCOOKIE_ORIGIN = "https://www.youtube-nocookie.com";
/** Flip to false to fall back to the canonical host if the IFrame API stops attaching to nocookie. */
export const USE_NOCOOKIE = true;

/**
 * Scripts + same-origin are the minimum the YouTube player runs with. Popups let the
 * player's own logo/title/ad links open a new tab (ADR 0011). No forms, modals or top navigation.
 */
const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
const ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";

/**
 * The only way the site builds an iframe: `embed` must parse as a canonical
 * allowlisted embed (ADR 0002/0003), otherwise nothing renders. The src is derived
 * from it: optionally the constant nocookie host, plus fixed IFrame API parameters.
 * `pageOrigin` is this page's origin, which the API needs to talk back to us.
 */
export function tvFrame(embed: unknown, pageOrigin: string = location.origin, nocookie: boolean = USE_NOCOOKIE): TvFrame | null {
  const r = v.safeParse(EmbedSchema, embed);
  // Twitch and Vimeo get their own frames and players in OME-124; until then, nothing renders.
  if (!r.success || r.output.provider !== "youtube") return null;
  const origin = httpOrigin(pageOrigin);
  if (origin === null) return null;
  const src = new URL(r.output.url);
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
  return { src: src.href, sandbox: SANDBOX, allow: ALLOW, referrerPolicy: "strict-origin-when-cross-origin" };
}

function httpOrigin(s: string): string | null {
  if (!URL.canParse(s)) return null;
  const u = new URL(s);
  return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
}
