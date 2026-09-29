import * as v from "valibot";
import { EmbedSchema } from "@omega/shared";

export interface TvFrame {
  readonly src: string;
  readonly sandbox: string;
  readonly allow: string;
  readonly referrerPolicy: ReferrerPolicy;
}

/** Scripts + same-origin are the minimum the YouTube player runs with. No popups, forms or top navigation. */
const SANDBOX = "allow-scripts allow-same-origin allow-presentation";
const ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";

/**
 * The only way the site builds an iframe: `embed` must parse as a canonical
 * allowlisted embed (ADR 0002/0003), otherwise nothing renders.
 */
export function tvFrame(embed: unknown): TvFrame | null {
  const r = v.safeParse(EmbedSchema, embed);
  if (!r.success) return null;
  const src = new URL(r.output.url);
  src.searchParams.set("autoplay", "1");
  src.searchParams.set("playsinline", "1");
  src.searchParams.set("rel", "0");
  // YouTube refuses to play embeds without a referrer, so don't use no-referrer.
  return { src: src.href, sandbox: SANDBOX, allow: ALLOW, referrerPolicy: "strict-origin-when-cross-origin" };
}
