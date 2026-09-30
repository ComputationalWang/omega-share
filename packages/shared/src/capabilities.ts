import type { Embed } from "./embed";

/** What the room can do with an embed's player (ADR 0014). Server and web both use it. */
export interface PlaybackCaps {
  /** Position can be set (false: Twitch live). */
  readonly seek: boolean;
  /** Live stream: only playing/paused is shared; position is always 0. */
  readonly live: boolean;
  /** "yes" settable; "probe" depends on the video (Vimeo owner plan); "no" never (Twitch). */
  readonly rate: "yes" | "probe" | "no";
}

const YOUTUBE: PlaybackCaps = Object.freeze({ seek: true, live: false, rate: "yes" });
const VIMEO: PlaybackCaps = Object.freeze({ seek: true, live: false, rate: "probe" });
const TWITCH_VOD: PlaybackCaps = Object.freeze({ seek: true, live: false, rate: "no" });
const TWITCH_LIVE: PlaybackCaps = Object.freeze({ seek: false, live: true, rate: "no" });

/** Static capabilities of an embed. Pure; returns shared frozen objects. */
export function playbackCaps(e: Embed): PlaybackCaps {
  switch (e.provider) {
    case "youtube":
      return YOUTUBE;
    case "vimeo":
      return VIMEO;
    case "twitch":
      return e.kind === "live" ? TWITCH_LIVE : TWITCH_VOD;
  }
}
