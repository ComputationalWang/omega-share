import { MAX_POSITION_S, playbackCaps, type Embed, type MemberId, type PlaybackState } from "@omega/shared";

/** A `control` message's payload. */
export interface Control {
  /** Canonical `Embed.url` of the video being controlled. */
  url: string;
  playing: boolean;
  position: number;
}

/** A position further than this from the extrapolated one counts as a seek (ADR 0011). */
const SEEK_THRESHOLD_S = 1;

const clamp = (s: number): number => Math.min(MAX_POSITION_S, Math.max(0, s));

/** The `load` state of a freshly shared embed. `prevRev` is the room's last rev (-1 if none); `by` is the sharer. */
export function loadPlayback(prevRev: number, now: number, by: MemberId | null = null): PlaybackState {
  return { playing: true, position: 0, rate: 1, at: now, rev: prevRev + 1, action: "load", by };
}

/** Where the video should be at server time `now`. */
export function expectedPosition(state: PlaybackState, now: number): number {
  return state.playing ? clamp(state.position + ((now - state.at) / 1000) * state.rate) : state.position;
}

/**
 * Applies `control` from `by` (last write wins). Returns null when there is no embed or
 * `control.url` is not the current embed's url. On a live embed the position is always 0
 * and a control is only a play or a pause (ADR 0014 §3).
 */
export function applyControl(
  state: PlaybackState | null,
  embed: Embed | null,
  control: Control,
  by: MemberId,
  now: number,
): PlaybackState | null {
  if (state === null || embed?.url !== control.url) return null;
  const live = playbackCaps(embed).live;
  const position = live ? 0 : clamp(control.position);
  const action =
    !live && Math.abs(position - expectedPosition(state, now)) > SEEK_THRESHOLD_S
      ? "seek"
      : control.playing
        ? "play"
        : "pause";
  return { playing: control.playing, position, rate: state.rate, at: now, rev: state.rev + 1, action, by };
}
