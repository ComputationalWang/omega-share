// What the real specs read of the room (OME-378). Dev builds expose window.__omega; a production build (the hosted
// origin) doesn't, so the same fields come from the DOM the playback chrome renders. Plain JS strings, so the raw-CDP
// specs (real-ads, real-youtube) and Playwright pages share one reading.
import type { Page } from "@playwright/test";
import type { PlaybackView } from "../../apps/web/src/controls/playback";

export interface RoomView extends Pick<PlaybackView, "playing" | "catching" | "live" | "seekOnly" | "canControl"> {
  /** `dev`: window.__omega; `dom`: read from the page (production builds). */
  readonly source: "dev" | "dom";
  /** The refusal reason the site shows (apps/web/src/controls/player-error.ts), or null. */
  readonly error: { readonly reason: string } | null;
}

/**
 * A JS expression for the room view. `auto` uses __omega when present; `dom` always reads the page:
 * - playing: the shared play key says "Pause for everyone";
 * - catching: my own nickname tag has the hourglass (`.self.catching`);
 * - live: the live pill shows; seekOnly: the "syncs by skipping" hint shows; canControl: the play key is enabled;
 * - error: the sync notice's text, mapped back to its reason.
 */
export const roomViewJs = (mode: "auto" | "dom" = "auto"): string => `(() => {
  const v = ${mode === "auto" ? "window.__omega?.room?.playback() ?? null" : "null"};
  if (v !== null) return { source: "dev", playing: v.playing, catching: v.catching, live: v.live, seekOnly: v.seekOnly,
    canControl: v.canControl, error: v.error === null ? null : { reason: v.error.reason } };
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');
  const shown = (e) => e instanceof HTMLElement && !e.hidden;
  const key = q("play-toggle");
  const notice = q("sync-notice");
  const text = shown(notice) ? notice.textContent : "";
  const reasons = [["owner doesn't allow", "refused"], ["unavailable", "not-found"], ["restricted", "restricted"],
    ["offline", "offline"], ["didn't start", "timeout"], ["reported an error", "other"]];
  const reason = text === "" ? null : (reasons.find(([t]) => text.includes(t))?.[1] ?? "other");
  return { source: "dom", playing: key?.getAttribute("aria-label") === "Pause for everyone",
    catching: document.querySelector('[data-testid="nickname-tag"].self.catching') !== null,
    live: shown(q("live-pill")), seekOnly: shown(q("seek-only-hint")), canControl: key !== null && !key.disabled,
    error: reason === null ? null : { reason } };
})()`;

export const roomView = (page: Page, mode: "auto" | "dom" = "auto"): Promise<RoomView> => page.evaluate<RoomView>(roomViewJs(mode));

/**
 * The landing page can take the Enter click: on a dev build once __omega is set; on a production build once the join
 * button is there and the document has loaded (the button is static HTML; main.ts, a deferred module, wires it first).
 */
export const joinReady = `location.pathname.startsWith("/r/") &&
  (window.__omega !== undefined || (document.querySelector('[data-testid="join-button"]') !== null && document.readyState === "complete"))`;
