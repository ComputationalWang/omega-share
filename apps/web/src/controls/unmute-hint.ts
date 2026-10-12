// Under the Unmute key when our unmute didn't take (QA OME-1001). Its own module: dom.ts must not pull in the player
// registry (and with it the SDK loaders' globals) through player-error.ts.
import type { Provider } from "@omega/shared";

const NAMES: Readonly<Record<Provider, string>> = { youtube: "YouTube", twitch: "Twitch", vimeo: "Vimeo" };

/** Point at the player's own speaker, not its picture: a tap there pauses the room. */
export function unmuteInPlayerText(provider: Provider | null): string {
  return `The ${provider === null ? "video" : NAMES[provider]} player kept the sound off. Turn it on with the speaker icon in the player.`;
}
