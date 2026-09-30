import type { YtNamespace, YtPlayer, YtPlayerOptions } from "../../src/player/youtube-types";

export type YtCall = [name: string, ...args: unknown[]];

/** Minimal in-memory YT.Player for adapter unit tests. Tests set the read-outs and fire events. */
export class FakeYtPlayer implements YtPlayer {
  readonly calls: YtCall[] = [];
  currentTime: unknown = 0;
  duration: unknown = 0;
  playerState: unknown = -1;
  videoData: unknown = { video_id: "" };
  availableRates: unknown = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  rate: unknown = 1;

  constructor(
    readonly el: unknown,
    readonly options: YtPlayerOptions,
    readonly extraArgs: number,
  ) {}

  fire(name: keyof YtPlayerOptions["events"], data?: unknown): void {
    if (name === "onStateChange" && typeof data === "number") this.playerState = data;
    const h = this.options.events[name];
    h?.({ target: this, data });
  }

  playVideo(): void {
    this.calls.push(["playVideo"]);
  }
  pauseVideo(): void {
    this.calls.push(["pauseVideo"]);
  }
  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.calls.push(["seekTo", seconds, allowSeekAhead]);
  }
  setPlaybackRate(rate: number): void {
    this.calls.push(["setPlaybackRate", rate]);
  }
  mute(): void {
    this.calls.push(["mute"]);
  }
  unMute(): void {
    this.calls.push(["unMute"]);
  }
  setVolume(v: number): void {
    this.calls.push(["setVolume", v]);
  }
  destroy(): void {
    this.calls.push(["destroy"]);
  }
  getCurrentTime(): unknown {
    return this.currentTime;
  }
  getDuration(): unknown {
    return this.duration;
  }
  getPlayerState(): unknown {
    return this.playerState;
  }
  getVideoData(): unknown {
    return this.videoData;
  }
  getAvailablePlaybackRates(): unknown {
    return this.availableRates;
  }
  getPlaybackRate(): unknown {
    return this.rate;
  }
}

export function fakeYt(): { yt: YtNamespace; players: FakeYtPlayer[] } {
  const players: FakeYtPlayer[] = [];
  class Player extends FakeYtPlayer {
    constructor(el: HTMLIFrameElement, options: YtPlayerOptions, ...rest: unknown[]) {
      super(el, options, rest.length);
      players.push(this);
    }
  }
  return { yt: { Player }, players };
}
