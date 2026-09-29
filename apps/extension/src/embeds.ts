import { canonicalizeEmbed, type Embed } from "@omega/shared";

/** Most candidate URLs we look at from one page scan; the rest are ignored. */
export const MAX_CANDIDATES = 500;

/**
 * Scan result → the embeds we can share: canonicalized through the contract's
 * allowlist, deduped by video, in first-seen order. `scan` comes from the page, so
 * anything that is not an array of strings is ignored.
 */
export function listEmbeds(scan: unknown): Embed[] {
  if (!Array.isArray(scan)) return [];
  const seen = new Map<string, Embed>();
  for (const candidate of scan.slice(0, MAX_CANDIDATES)) {
    if (typeof candidate !== "string") continue;
    const embed = canonicalizeEmbed(candidate);
    if (embed !== null && !seen.has(embed.url)) seen.set(embed.url, embed);
  }
  return [...seen.values()];
}
