import type { Provider } from "@omega/shared";
import type { PlayerError } from "../player/adapter";
import type { MountFailure } from "../player/registry";

// The site's own notice when the provider refuses the room's video (research M1b §1.1, M2 §6.2). The in-player
// text alone isn't enough: without this the transport would keep saying the room plays here.
const PREFIX = "This video can't play here";

const NAMES: Readonly<Record<Provider, string>> = { youtube: "YouTube", twitch: "Twitch", vimeo: "Vimeo" };

/** Notice text for a player error, by its provider-neutral reason. */
export function playerErrorText(e: PlayerError): string {
  switch (e.reason) {
    case "refused":
      return `${PREFIX}: the owner doesn't allow playback on other sites.`;
    case "not-found":
      return `${PREFIX}: it's unavailable (removed or private).`;
    case "restricted":
      return `${PREFIX}: it's restricted (age, subscription or region).`;
    case "offline":
      return `${PREFIX}: the channel is offline.`;
    case "timeout":
      return `${PREFIX}: the player didn't start.`;
    case "other":
      return `${PREFIX}: the player reported an error (code ${e.code}).`;
  }
}

/** Notice text when no synced player could be attached to the TV. */
export function mountErrorText(provider: Provider, reason: MountFailure): string {
  switch (reason) {
    case "load-failed":
    case "timeout":
      return `The video plays here without sync: the ${NAMES[provider]} player API didn't load.`;
    case "unsupported":
      return `Sync for ${NAMES[provider]} videos isn't ready yet.`;
    case "invalid":
      return `${PREFIX}: the player didn't match the room's video.`;
  }
}

/**
 * A standing one-line hint under the TV for the shown provider, or null. Twitch gates mature channels behind its own
 * "Start Watching" interstitial while the video plays on behind it (OME-244). The player is cross-origin, so we can't
 * tell whether it's up: the hint shows for every Twitch embed.
 */
export function providerHint(provider: Provider): string | null {
  return provider === "twitch" ? "If the Twitch player asks, press Start Watching in it." : null;
}
