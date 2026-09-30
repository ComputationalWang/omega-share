import { MAX_POSITION_S, type MemberId, type PlaybackState } from "@omega/shared";

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

/** The `load` state of a freshly shared embed. `prevRev` is the room's last rev (-1 if none). */
export function loadPlayback(prevRev: number, now: number): PlaybackState {
  return { playing: true, position: 0, rate: 1, at: now, rev: prevRev + 1, action: "load", by: null };
}

/** Where the video should be at server time `now`. */
export function expectedPosition(state: PlaybackState, now: number): number {
  return state.playing ? clamp(state.position + ((now - state.at) / 1000) * state.rate) : state.position;
}

/**
 * Applies `control` from `by` (last write wins). Returns null when there is no embed or
 * `control.url` is not the current embed's url.
 */
export function applyControl(
  state: PlaybackState | null,
  embedUrl: string | null,
  control: Control,
  by: MemberId,
  now: number,
): PlaybackState | null {
  if (state === null || embedUrl === null || control.url !== embedUrl) return null;
  const position = clamp(control.position);
  const action =
    Math.abs(position - expectedPosition(state, now)) > SEEK_THRESHOLD_S ? "seek" : control.playing ? "play" : "pause";
  return { playing: control.playing, position, rate: state.rate, at: now, rev: state.rev + 1, action, by };
}
