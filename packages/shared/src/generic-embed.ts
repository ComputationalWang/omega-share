import * as v from "valibot";
import { MAX_URL_LENGTH } from "./constants";
import { EmbedSchema, canonicalizeEmbed, syncedProviderFor, type Embed } from "./embed";

/** Longest canonical generic embed URL we store or broadcast (ADR 0024 §1). */
export const MAX_GENERIC_EMBED_URL_LENGTH = 1024;

/** Hostname label: 1–63 of `[a-z0-9-]`, no hyphen at either end. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/**
 * Last label must be alphabetic or punycode. The URL parser turns any host whose last
 * label is numeric (or hex) into a dotted IPv4 address, so this also rejects every IPv4
 * literal (`2130706433`, `0x7f.1`, `127.1`); IPv6 literals fail `LABEL` on `[`.
 */
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Special-use and private-network names: they only resolve inside someone's network. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "intranet", "arpa"] as const;
/** Public wildcard DNS that answers with loopback or with an IP spelled in the name. */
const IP_IN_DNS_DOMAINS = ["localtest.me", "lvh.me", "vcap.me", "localhost.direct", "nip.io", "sslip.io", "xip.io", "traefik.me"] as const;

function underDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

function isPublicDnsName(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  if (!TLD.test(labels[labels.length - 1] ?? "")) return false;
  return !underDomain(host, PRIVATE_SUFFIXES) && !underDomain(host, IP_IN_DNS_DOMAINS);
}

export interface GenericEmbedOptions {
  /** Our own hostnames; they and their subdomains are rejected. The server passes its public host(s). */
  readonly ownHosts?: readonly string[];
}

/**
 * An embed from any other site (ADR 0024). Not synced: every viewer plays it on their
 * own. `url` is canonical and `host` is its punycode hostname, shown on the load card.
 * Written out (not inferred) because the schema's check calls the canonicalizer.
 */
export interface GenericEmbed {
  provider: "generic";
  host: string;
  url: string;
}

export const GenericEmbedSchema = v.pipe(
  v.object({
    provider: v.literal("generic"),
    host: v.string(),
    url: v.pipe(v.string(), v.maxLength(MAX_GENERIC_EMBED_URL_LENGTH)),
  }),
  v.check((e) => {
    const c = canonicalizeGenericEmbed(e.url);
    return c !== null && c.url === e.url && c.host === e.host;
  }, "url is not a canonical generic embed url"),
);

/** What a room can show: a synced embed or a generic one. This is the wire type. */
export const AnyEmbedSchema = v.variant("provider", [EmbedSchema, GenericEmbedSchema]);
export type AnyEmbed = Embed | GenericEmbed;

/** True for the synced tier (YouTube, Twitch, Vimeo). */
export function isSyncedEmbed(e: AnyEmbed): e is Embed {
  return e.provider !== "generic";
}

/**
 * Validate and canonicalize a generic embed URL: `https:` only, no userinfo, default port,
 * a public DNS name (no IP literal, no private or special-use name), not one of `ownHosts`
 * and not a synced provider's host. Null when any rule fails. Pure; never throws.
 */
export function canonicalizeGenericEmbed(input: string, opts: GenericEmbedOptions = {}): GenericEmbed | null {
  if (input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname;
  if (!isPublicDnsName(host)) return null;
  if (syncedProviderFor(host) !== undefined) return null;
  const own = (opts.ownHosts ?? []).map((h) => h.toLowerCase());
  if (underDomain(host, own)) return null;
  const href = url.href;
  if (href.length > MAX_GENERIC_EMBED_URL_LENGTH) return null;
  return { provider: "generic", host, url: href };
}

export interface AnyEmbedOptions extends GenericEmbedOptions {
  /** The `GENERIC_EMBEDS` kill switch; false accepts the synced tier only. */
  readonly generic: boolean;
}

/**
 * The share path: a synced provider's URL becomes its synced embed or nothing; any other
 * URL becomes a generic embed when `generic` is on. Pure; never throws.
 */
export function canonicalizeAnyEmbed(input: string, opts: AnyEmbedOptions): AnyEmbed | null {
  const synced = canonicalizeEmbed(input);
  if (synced !== null) return synced;
  return opts.generic ? canonicalizeGenericEmbed(input, opts) : null;
}

/** Wire rule: playback state exists only for a synced embed (null for a generic one). */
export function playbackMatchesEmbed(x: { readonly embed: AnyEmbed | null; readonly playback?: unknown }): boolean {
  const playback = x.playback ?? null;
  if (x.embed === null) return playback === null;
  return isSyncedEmbed(x.embed) || playback === null;
}
