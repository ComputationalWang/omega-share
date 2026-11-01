// The room's TV and its shelf (split out of room.ts, OME-1100): what the picture shows for the room's embed (nothing, a
// synced player, or a generic page's load card, ADR 0024 §3) and the controls under it.
import { isSyncedEmbed, type Embed } from "@omega/shared";
import { createPersonal, createTransport, el, sprite } from "./controls/dom";
import { createGenericTv, type GenericTv } from "./controls/generic-tv";
import type { PlaybackController, PlaybackView } from "./controls/playback";
import { mountErrorText, playerErrorText, providerHint } from "./controls/player-error";
import { createQualityPicker } from "./controls/quality-picker";
import type { ExtensionBridge } from "./extension-bridge";
import type { PlayerError } from "./player/adapter";
import { PLAYERS, createPlayerMounter } from "./player/registry";
import type { ViewState } from "./state";
import { genericFrame, tvFrame, twitchFallbackFrame, type TvFrame, type TvIframe } from "./tv";

export interface RoomTvOptions {
  readonly playback: PlaybackController;
  readonly extension: ExtensionBridge;
  /** The full-screen element: the quality list hangs in it, under the shelf. */
  readonly wrap: HTMLElement;
  readonly fullscreen: () => boolean;
  /** The shown provider changed: Twitch needs a larger TV (layout.ts). */
  readonly onProvider: () => void;
  /** The empty TV's message was pressed: take the viewer to the paste field (OME-2104). */
  readonly onCurtain: () => void;
}

export interface RoomTv {
  readonly tv: HTMLElement;
  readonly controls: HTMLElement;
  /** The full-screen key (OME-597): it ends the shelf in either tier. */
  readonly fsKey: HTMLElement;
  /** Your volume and speed: hidden for a generic embed. */
  readonly personal: HTMLElement;
  /** Why the player didn't load or failed. */
  readonly notice: HTMLElement;
  /** The provider hint above the TV (OME-251). */
  readonly hint: HTMLElement;
  /** The shown embed's provider, if it's synced. */
  readonly provider: () => Embed["provider"] | null;
  /** The TV shows its closed curtain: no player, no Load card (the tour's chip may sit on it, OME-1778). */
  readonly empty: () => boolean;
  /** The curtain's message: the chip may sit on the curtain, never on this (OME-2104). */
  readonly message: HTMLElement;
  /** Swap the TV for the room's embed. */
  readonly sync: (s: ViewState) => void;
  /** The shelf follows the player. */
  readonly show: (v: PlaybackView) => void;
  /** Full screen began or ended: the key says so, and the quality list is a row there (a tray under the shelf in the page). */
  readonly setFullscreen: (on: boolean) => void;
  /** The open tray follows its key after a layout change. */
  readonly place: () => void;
}

export function createRoomTv(o: RoomTvOptions): RoomTv {
  const { playback, wrap } = o;
  // A personal key: it changes only your screen.
  const fsKey = el("button", { type: "button", className: "ui-button self icon fs-key", ariaLabel: "Full screen" }, "fullscreen-toggle");
  fsKey.setAttribute("aria-keyshortcuts", "F");
  const fsIcon = sprite("ui-icon-fullscreen");
  fsKey.append(fsIcon);
  const tv = el("div", { className: "tv ui-tv-frame" }, "tv");
  const controls = el("div", { className: "controls ui-tv-shelf", role: "group", ariaLabel: "Playback controls" });
  // Nothing on: the theatre's curtain, closed (OME-1812, design OME-1799 §5). Only ever in the box without a player (ADR 0012).
  const tvEmpty = el("div", { className: "tv-curtain" });
  // A key, not a line: on a phone held upright the paste field is behind Up next, so the message takes you there.
  const curtainKey = el("button", { type: "button", className: "tv-empty", textContent: "Nothing on yet. Paste a link in Up next to raise the curtain." }, "tv-empty");
  curtainKey.addEventListener("click", o.onCurtain);
  tvEmpty.append(curtainKey);
  tv.append(tvEmpty);
  const syncNotice = el("p", { className: "notice sync-notice", role: "status", hidden: true }, "sync-notice");
  const tvHint = el("p", { className: "notice tv-hint", hidden: true }, "tv-hint");

  const transport = createTransport(playback);
  const personal = createPersonal(playback);
  // Quality, only you (OME-599, set k `ui-m7-quality`): a key before full screen, only where the player can be set.
  const quality = createQualityPicker(playback, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => {
      clearTimeout(h);
    },
  });
  /** The synced tier's shelf. The volume pod rides in it, right under the picture (OME-642): you reach for it while you watch. */
  const syncShelf = (): void => {
    controls.replaceChildren(transport.root, personal.pod, quality.key, fsKey);
  };
  syncShelf();
  /** In the page the list hangs under the shelf, over the room (ours), its tail on the key; never over the picture. */
  const placeQuality = (): void => {
    if (!quality.isOpen() || quality.menu.parentElement !== wrap) return;
    const m = quality.menu;
    const k = quality.key;
    // The list zooms with the shelf (OME-1667), so both are in the shelf's px.
    m.style.zoom = controls.style.zoom;
    const right = controls.offsetLeft + k.offsetLeft + k.offsetWidth / 2;
    const left = Math.max(0, right - m.offsetWidth + 24);
    m.style.left = `${String(left)}px`;
    m.style.top = `${String(controls.offsetTop + controls.offsetHeight + 8)}px`;
    m.style.setProperty("--ui-tail-x", `${String(right - left)}px`);
  };
  quality.onToggle((open) => {
    // Full screen: the list takes the shelf's place, so nothing grows over the picture.
    const row = o.fullscreen();
    controls.classList.toggle("is-quality-row", open && row);
    if (!open) {
      quality.menu.remove();
      return;
    }
    if (row) {
      quality.menu.style.zoom = "";
      controls.append(quality.menu);
    }
    else {
      wrap.append(quality.menu);
      placeQuality();
    }
  });

  let shownPlayerError: PlayerError | null = null;
  const show = (v: PlaybackView): void => {
    transport.update(v);
    personal.update(v);
    quality.update(v);
    if (v.error !== shownPlayerError) {
      shownPlayerError = v.error;
      // The only other sync notice (API didn't load) never has a player, so there's no error to clash with.
      syncNotice.textContent = v.error === null ? "" : playerErrorText(v.error);
      syncNotice.hidden = v.error === null;
    }
  };

  let tvKey: string | null = null;
  /** The shown embed's provider: Twitch needs a larger TV (layout.ts). */
  let tvProvider: Embed["provider"] | null = null;
  const mount = createPlayerMounter(PLAYERS);
  /** What the TV shows now: the iframe we built, or the container a provider SDK renders into. */
  let tvScreen: HTMLElement | null = null;
  /** Counts frame attaches, so only the newest one's answer counts. */
  let frameAttempt = 0;
  const tvIframe = (f: TvIframe, testId = "shared-video"): HTMLIFrameElement => {
    const iframe = el("iframe", { src: f.src, allow: f.allow, referrerPolicy: f.referrerPolicy, title: "Shared video" }, testId);
    iframe.setAttribute("sandbox", f.sandbox);
    return iframe;
  };
  const mountPlayer = (embed: Embed, frame: TvFrame, screenEl: HTMLElement, iframe: HTMLIFrameElement | null): void => {
    syncNotice.hidden = true;
    // Only the shown embed's provider module and SDK load, and only now (ADR 0014, research §5).
    // mount() never rejects (registry.ts).
    void mount({ embed, frame, target: { iframe, container: screenEl }, now: () => performance.now() }).then((r) => {
      if (tvScreen !== screenEl) {
        if (r.ok) r.player.destroy();
        return;
      }
      if (!r.ok) {
        // No Twitch SDK means no player at all: show the plain player so the notice's "plays here" holds (OME-1665).
        if (frame.kind === "twitch" && r.reason !== "invalid") screenEl.replaceChildren(tvIframe(twitchFallbackFrame(frame), "twitch-fallback"));
        syncNotice.textContent = mountErrorText(embed.provider, r.reason);
        syncNotice.hidden = false;
        return;
      }
      playback.attach(r.player, embed.url);
    });
  };

  /**
   * Swap the TV iframe with the embed. Runs from dispatch, not the next frame: rAF doesn't fire in a
   * background tab, and the old video must not keep playing (unsynced) after the controller dropped it.
   */
  const syncTv = (s: ViewState): void => {
    const embed = s.room?.embed ?? null;
    if (embed !== null && !isSyncedEmbed(embed)) {
      showGeneric(embed, s.room?.itemId);
      return;
    }
    const tf = tvFrame(embed);
    const nextKey = tf?.key ?? null;
    if (nextKey !== tvKey) {
      tvKey = nextKey;
      o.extension.relock();
      showSyncChrome(true);
      const provider = tf === null ? null : (embed?.provider ?? null);
      if (provider !== tvProvider) {
        tvProvider = provider;
        const hint = provider === null ? null : providerHint(provider);
        tvHint.textContent = hint ?? "";
        tvHint.hidden = hint === null;
        o.onProvider();
      }
      if (tf === null || embed === null) {
        tvScreen = null;
        tv.replaceChildren(tvEmpty);
      } else if (tf.kind === "iframe") {
        const iframe = tvIframe(tf);
        tvScreen = iframe;
        tv.replaceChildren(iframe);
        mountPlayer(embed, tf, iframe, iframe);
      } else {
        // The Twitch SDK builds its own iframe inside a fresh container; its adapter checks the result (ADR 0014 §5).
        const box = el("div", { className: "tv-sdk" }, "shared-video");
        tvScreen = box;
        tv.replaceChildren(box);
        mountPlayer(embed, tf, box, null);
      }
    }
  };

  /** The sync controls and your volume belong to the synced tier; the generic tier's strip takes their slot. */
  const showSyncChrome = (synced: boolean): void => {
    // The whole synced shelf, the volume pod too (after a generic item the strip had its slot).
    if (synced && controls.firstChild !== transport.root) syncShelf();
    personal.root.hidden = !synced;
  };

  /** The generic tier's shelf: its strip, and the sync controls and your volume only while the frame is attached (ADR 0057 §4). */
  const genericShelf = (g: GenericTv, attached: boolean): void => {
    if (attached) controls.replaceChildren(g.strip, transport.root, personal.pod, fsKey);
    else controls.replaceChildren(g.strip, fsKey);
    personal.root.hidden = !attached;
  };

  /**
   * After an unlocked frame loaded: the frame adapter (ADR 0057 §4), lazily, like the other players. No frame-state
   * within its timeout leaves the frame unsynced. A later load (the strip's Unlock reloads the frame) supersedes it.
   */
  const attachFrame = (g: GenericTv, host: string, url: string): void => {
    const attempt = ++frameAttempt;
    const current = (): boolean => tvScreen === g.screen && attempt === frameAttempt;
    void import("./player/frame")
      .then((m) =>
        m.mountFrame({
          host,
          bridge: o.extension,
          now: () => performance.now(),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => {
            clearTimeout(h);
          },
          onSync: (on) => {
            if (!current()) return;
            g.setSync(on ? "on" : "off");
            genericShelf(g, on);
          },
        }),
      )
      .then(
        (r) => {
          if (!current()) {
            if (r.ok) r.player.destroy();
            return;
          }
          if (r.ok) playback.attach(r.player, url);
          else g.setSync("failed");
        },
        () => {
          if (current()) g.setSync("failed");
        },
      );
  };

  /** A generic embed (ADR 0024 §3): the load card, and after Load one sandboxed iframe; synced only through the extension (ADR 0057). */
  const showGeneric = (embed: unknown, itemId: string | undefined): void => {
    const gf = genericFrame(embed);
    // Keyed by queue item too: the same page queued twice is a new card, so it waits for its own Load click.
    const nextKey = gf === null ? null : `generic:${itemId ?? ""}:${gf.key}`;
    if (nextKey === tvKey) return;
    tvKey = nextKey;
    o.extension.relock();
    tvScreen = null;
    syncNotice.hidden = true;
    tvHint.hidden = true;
    if (tvProvider !== null) {
      tvProvider = null;
      o.onProvider();
    }
    showSyncChrome(false);
    if (gf === null) {
      // Our own host or a malformed embed: render nothing from it.
      controls.replaceChildren(fsKey);
      tv.replaceChildren(tvEmpty);
      return;
    }
    const g: GenericTv = createGenericTv(gf, o.extension, () => {
      attachFrame(g, gf.host, gf.src);
    });
    tvScreen = g.screen;
    tv.replaceChildren(g.screen);
    genericShelf(g, false);
  };

  return {
    tv,
    controls,
    fsKey,
    personal: personal.root,
    notice: syncNotice,
    hint: tvHint,
    provider: () => tvProvider,
    empty: () => tv.firstChild === tvEmpty,
    message: curtainKey,
    sync: syncTv,
    show,
    setFullscreen: (on) => {
      // It closes as the layout changes.
      quality.setRow(on);
      fsKey.ariaLabel = on ? "Exit full screen" : "Full screen";
      fsIcon.className = `ui-sprite ${on ? "ui-icon-fullscreen-exit" : "ui-icon-fullscreen"}`;
    },
    place: placeQuality,
  };
}
