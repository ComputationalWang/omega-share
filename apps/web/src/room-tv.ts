// The room's TV and its shelf (split out of room.ts, OME-1100): what the picture shows for the room's embed (nothing, a
// synced player, or a generic page's load card, ADR 0024 §3) and the controls under it.
import { isSyncedEmbed, type AnyEmbed, type Embed } from "@omega/shared";
import { createPersonal, createTransport, el, sprite } from "./controls/dom";
import { createGenericTv } from "./controls/generic-tv";
import type { PlaybackController, PlaybackView } from "./controls/playback";
import { mountErrorText, playerErrorText, providerHint } from "./controls/player-error";
import { createQualityPicker } from "./controls/quality-picker";
import type { ExtensionBridge } from "./extension-bridge";
import type { PlayerError } from "./player/adapter";
import { PLAYERS, createPlayerMounter } from "./player/registry";
import type { ViewState } from "./state";
import { genericFrame, tvFrame, type TvFrame } from "./tv";

export interface RoomTvOptions {
  readonly playback: PlaybackController;
  readonly extension: ExtensionBridge;
  /** The full-screen element: the quality list hangs in it, under the shelf. */
  readonly wrap: HTMLElement;
  readonly fullscreen: () => boolean;
  /** The shown provider changed: Twitch needs a larger TV (layout.ts). */
  readonly onProvider: () => void;
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
  /** Swap the TV for the room's embed. */
  readonly sync: (s: ViewState) => void;
  /** The shelf follows the player. */
  readonly show: (v: PlaybackView) => void;
  /** Full screen began or ended: the key says so, and the quality list is a row there (a tray under the shelf in the page). */
  readonly setFullscreen: (on: boolean) => void;
  /** The open tray follows its key after a layout change. */
  readonly place: () => void;
}

/** What the sync loop plays: the synced embed, or null (a generic embed is never synced, ADR 0024). */
export function syncedOnly(e: AnyEmbed | null | undefined): Embed | null {
  return e != null && isSyncedEmbed(e) ? e : null;
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
  const tvEmpty = el("p", { className: "tv-empty", textContent: "Share a video with the extension, or paste a link under Up next, to watch it here." });
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
    // The shelf's offsets are in its own px: the wide page zooms it (OME-1667), the list it hangs isn't.
    const z = controls.currentCSSZoom;
    const right = (controls.offsetLeft + k.offsetLeft + k.offsetWidth / 2) * z;
    const left = Math.max(0, right - m.offsetWidth + 24);
    m.style.left = `${String(left)}px`;
    m.style.top = `${String((controls.offsetTop + controls.offsetHeight) * z + 8)}px`;
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
    if (row) controls.append(quality.menu);
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
    const any = s.room?.embed ?? null;
    if (any !== null && !isSyncedEmbed(any)) {
      showGeneric(any, s.room?.itemId);
      return;
    }
    const embed = syncedOnly(any);
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
        const iframe = el("iframe", { src: tf.src, allow: tf.allow, referrerPolicy: tf.referrerPolicy, title: "Shared video" }, "shared-video");
        iframe.setAttribute("sandbox", tf.sandbox);
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

  /** A generic embed (ADR 0024 §3): the load card, and after Load one sandboxed iframe. No player, no sync loop. */
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
    const g = createGenericTv(gf, o.extension);
    tv.replaceChildren(g.screen);
    controls.replaceChildren(g.strip, fsKey);
  };

  return {
    tv,
    controls,
    fsKey,
    personal: personal.root,
    notice: syncNotice,
    hint: tvHint,
    provider: () => tvProvider,
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
