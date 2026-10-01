import { canonicalizeAnyEmbed, isSyncedEmbed, normalizeHostname, type AnyEmbed } from "@omega/shared";

export interface EmbedPolicyOptions {
  /** The GENERIC_EMBEDS kill switch (ADR 0024 §5). */
  genericEmbeds: boolean;
  /** Our own hostnames: they and their subdomains are never a generic embed. */
  ownHosts: readonly string[];
  /** GENERIC_EMBED_DENYLIST: domains whose hosts and subdomains are refused (ADR 0024 §6). */
  denylist: readonly string[];
}

function normalized(hosts: readonly string[], what: string): string[] {
  return hosts.map((h) => normalizeHostname(h) ?? fail(what, h));
}
const fail = (what: string, host: string): never => {
  throw new Error(`invalid ${what} entry ${JSON.stringify(host)}: not a bare hostname`);
};

/**
 * Which embeds this server accepts: a synced provider's, or a generic one when the switch is on, its
 * host is not ours and not denied. The share path and the restore after a restart both go through it.
 */
export class EmbedPolicy {
  readonly genericEmbeds: boolean;
  readonly #ownHosts: readonly string[];
  readonly #denylist: readonly string[];

  constructor(opts: EmbedPolicyOptions) {
    this.genericEmbeds = opts.genericEmbeds;
    this.#ownHosts = normalized(opts.ownHosts, "own host");
    this.#denylist = normalized(opts.denylist, "denylist");
  }

  /** The denylist hook: `host` is a denied domain or one of its subdomains. */
  isDeniedHost(host: string): boolean {
    return this.#denylist.some((d) => host === d || host.endsWith(`.${d}`));
  }

  /** The embed a shared URL becomes, or null for `unsupported_url`. */
  accept(url: string): AnyEmbed | null {
    const embed = canonicalizeAnyEmbed(url, { generic: this.genericEmbeds, ownHosts: this.#ownHosts });
    if (embed === null || isSyncedEmbed(embed)) return embed;
    return this.isDeniedHost(embed.host) ? null : embed;
  }

  /** A stored embed if this policy would still accept it, else null (kill switch off, newly denied host). */
  restore(embed: AnyEmbed | null): AnyEmbed | null {
    if (embed === null || isSyncedEmbed(embed)) return embed;
    const again = this.accept(embed.url);
    return again?.url === embed.url ? again : null;
  }
}
