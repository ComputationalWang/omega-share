// The room's stage: the Pixi room (floor, furniture, seats, avatars), the seat keys over it, the nickname tags, chat
// bubbles, emote badges and the system-line rail. Drawn from the room's state on the frames the caller asks for. Made
// once per page: the room tab's (room.ts), or, with the room popped out, the room window's (popout/room-pop.ts, OME-600),
// so the window draws exactly what the page would. The caller owns what clicks on a seat do.
import { SEAT_COUNT, layoutSeats, type EmoteKind, type MemberId, type RoomLayout } from "@omega/shared";
import { createFloats } from "./bubbles/floats";
import { createHandoff } from "./bubbles/handoff";
import { el, renderSyslines } from "./controls/dom";
import { createEmoteBadges } from "./emote/badges";
import type { FurnitureAtlas } from "./furniture-atlas";
import { layoutKey as keyOfLayout, layoutOf, sceneOf, seatPoints, standDepth, standingPoints, usesSetG } from "./furniture";
import type { RoomAtlas } from "./room-atlas";
import { seatViews } from "./intents";
import { SYSLINE_RAIL, TAG_OFFSET_Y, type Point, type Rect } from "./layout";
import { createRoomView, type AvatarPlacement, type RoomView } from "./room-view";
import { BUBBLE_MS, catchingUp, type StageState } from "./state";
import { EMOTE_LIFT } from "./walk/animator";
import { walkGrid } from "./walk/path";
import { standingPlacement } from "./walk/standing";
import { awayChanges } from "./session-lifecycle";
import type { Dir } from "./walk/walks";

export interface StageOptions {
  /** Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415). */
  readonly reducedMotion: { readonly matches: boolean };
  /** Draw again on the next frame (the furniture atlas arrived). */
  readonly requestRender: () => void;
  /** The seats moved (a new layout): the phone's room window looks at their middle. */
  readonly onLayout?: (seats: readonly Point[]) => void;
  /** An avatar moved a whole pixel (it's walking): the emote wheel closes when it's mine (OME-732). */
  readonly onMove?: (id: MemberId) => void;
}

export interface Stage {
  /** The stage element (`data-testid=room`): the canvas and every layer over it, at 960×600 stage px. */
  readonly root: HTMLElement;
  /** The seat keys' layer: one `[data-seat]` button per seat. */
  readonly overlay: HTMLElement;
  /** The nickname tags' layer (the owner's moderation tools hang their menu off a tag). */
  readonly tags: HTMLElement;
  readonly view: RoomView;
  /** Draw `s` with `layout` (the room's, or the owner's draft); `selfCatching` is my own player's catching-up flag. */
  render(s: StageState, layout: RoomLayout, selfCatching: boolean): void;
  /** Only the catching-up hourglasses (my player's flag changes between renders). */
  applyCatching(s: StageState, selfCatching: boolean): void;
  emote(id: MemberId, kind: EmoteKind, s: StageState): void;
  /** "Hide for me" (OME-769): this member's tag and avatar dimmed (or not). Per change, never per frame. */
  hide(id: MemberId, hidden: boolean): void;
  /** Where seat `i` is (stage px), for the phone's window. */
  seat(i: number): Point | undefined;
  /** Where a member is drawn now, or was put by the last render. */
  anchor(id: MemberId): Point | undefined;
  /** Where a member's emote shows (stage px): `anchor` lifted by EMOTE_LIFT. */
  head(id: MemberId): Point | undefined;
  /** How many times the furniture was rebuilt for a new layout. */
  layoutBuilds(): number;
}

function place(e: HTMLElement, p: Point): void {
  e.style.transform = `translate(${String(p.x)}px, ${String(p.y)}px)`;
}

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
}

export async function createStage(o: StageOptions): Promise<Stage> {
  // .ui-room: set (e)/(c) chrome inside the stage is at the room's 1× art scale.
  const root = el("div", { className: "stage ui-room" }, "room");
  const overlay = el("div", { className: "overlay" });
  // Placed from the room's layout on each render that changes it (applyLayout).
  const seatButtons = Array.from({ length: SEAT_COUNT }, (_, i) => {
    const b = el("button", { type: "button", className: "seat" }, "seat");
    b.dataset["seat"] = String(i);
    return b;
  });
  overlay.append(...seatButtons);
  const tags = el("div", { className: "tags" });
  // Decorative (createFloats makes it aria-hidden): the chat log is the accessible record of what was said.
  const bubbles = el("div", { className: "bubbles" });
  // Chat system lines ("Ana paused"): caption rail in the stage's bottom-left, text only.
  const rail = el("div", { className: "syslines", ariaLive: "polite" });
  box(rail, SYSLINE_RAIL);

  const tagEls = new Map<MemberId, HTMLElement>();
  /** Members I hid (OME-769): their tags are made dimmed too. */
  const hiddenIds = new Set<MemberId>();
  const timers = {
    setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimer: (h: unknown): void => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };
  const floats = createFloats(bubbles, { reducedMotion: o.reducedMotion, now: () => Date.now(), ...timers });
  const handoff = createHandoff();
  const speaking = new Set<MemberId>();
  const badges = createEmoteBadges(bubbles, timers);
  /** The seats as last drawn, for the emote lift (a sitter's sticker sits lower). */
  let seated: readonly (MemberId | null)[] = [];
  const liftOf = (id: MemberId): number => (seated.includes(id) ? EMOTE_LIFT.sit : EMOTE_LIFT.idle);
  // Tags, bubbles and emote badges ride along with a walking avatar; a bubble's tail tips just over the head.
  const view = await createRoomView({
    onMove: (id, x, y) => {
      const head = y - liftOf(id);
      badges.move(id, x, head);
      floats.move(id, x, head);
      const tag = tagEls.get(id);
      if (tag !== undefined) place(tag, { x, y: y + TAG_OFFSET_Y });
      o.onMove?.(id);
    },
    onStop: (id, x, y) => {
      floats.settle(id, x, y - liftOf(id));
    },
  });
  view.canvas.className = "scene";
  root.append(view.canvas, overlay, tags, bubbles, rail);

  let drawnSeats: readonly unknown[] | undefined;
  let drawnMembers: readonly unknown[] | undefined;
  const syslineEls = new Map<number, HTMLElement>();
  /** The drawn layout (furniture.ts): seats, standing spots and the scene follow it; null until the first render. */
  let layout: RoomLayout | null = null;
  let seats: Point[] = [];
  let seatFacings: Dir[] = [];
  /** Who stands on which standing spot; kept across renders so a departure doesn't move the others. */
  let standSpots = new Map<MemberId, number>();
  /** Who is drawn away now, so a member who left while away is un-dimmed in the view's set. */
  let awayIds: ReadonlySet<MemberId> = new Set<MemberId>();
  let grid: Uint8Array = new Uint8Array(0);
  let standing: Point[] = [];
  let scene = sceneOf(layoutOf(null), null);
  /** The set (g) atlas once loaded: later layouts build their scene with it straight away. */
  let atlas: FurnitureAtlas | null = null;
  /** The room atlas (planks, walls, room-atlas kinds) once loaded; every room uses it. */
  let roomAtlas: RoomAtlas | null = null;
  /** The drawn layout's content; a re-join snapshot parses a new but equal layout, which keeps the scene. */
  let layoutKey = "";
  let layoutBuilds = 0;
  /** Where the last render put each member (seat or standing spot), for UI anchored to someone not on screen yet. */
  let placedAt = new Map<MemberId, Point>();
  /** The hourglass on each catching tag; a tag removed with its member takes its hourglass along. */
  const hourglasses = new Map<HTMLElement, HTMLElement>();

  const buildScene = (l: RoomLayout): void => {
    scene = sceneOf(l, atlas?.manifest ?? null, roomAtlas?.manifest ?? null);
    view.setScene(scene, [atlas, roomAtlas], grid);
    drawnSeats = undefined;
  };

  /** Load an atlas in its own chunk, then rebuild the scene if the room still shows `key`'s layout. */
  const lazyAtlas = <T>(what: string, key: string, l: RoomLayout, load: () => Promise<T>, keep: (loaded: T) => void): void => {
    void load()
      .then((loaded) => {
        keep(loaded);
        if (layoutKey !== key) return;
        buildScene(l);
        o.requestRender();
      })
      // Without the sheet the room still works: placeholder floor, seats and avatars. The next snapshot retries.
      .catch((e: unknown) => {
        if (layoutKey === key) layoutKey = "";
        console.warn(`${what} atlas failed to load`, e);
      });
  };

  /** Rebuild furniture, seats and standing spots for a new layout; the set (g) atlas loads only if the layout needs it. */
  const applyLayout = (next: RoomLayout): void => {
    layout = next;
    const key = keyOfLayout(next);
    if (key === layoutKey) return;
    layoutKey = key;
    layoutBuilds++;
    seats = seatPoints(next);
    o.onLayout?.(seats);
    seatFacings = layoutSeats(next).map((s) => s.facing);
    grid = walkGrid(next);
    standing = standingPoints(next);
    buildScene(next);
    // The translate property, not transform: style.css turns the seat into the floor diamond with its transform.
    seatButtons.forEach((b, i) => {
      const p = seats[i];
      if (p !== undefined) b.style.translate = `${String(p.x)}px ${String(p.y)}px`;
    });
    if (roomAtlas === null) {
      lazyAtlas("room", key, next, () => import("./room-atlas").then((m) => m.loadRoomAtlas()), (a) => (roomAtlas = a));
    }
    if (usesSetG(next) && atlas === null) {
      lazyAtlas("furniture", key, next, () => import("./furniture-atlas").then((m) => m.loadFurnitureAtlas()), (a) => (atlas = a));
    }
  };

  /** A tag carries the hourglass while that member catches up: mine from my player, others' from the server (ADR 0019). */
  const applyCatching = (s: StageState, selfCatching: boolean): void => {
    for (const [id, tag] of tagEls) {
      const want = id === s.self ? selfCatching : catchingUp(s, id);
      const glass = hourglasses.get(tag);
      if (want === (glass !== undefined)) continue;
      tag.classList.toggle("catching", want);
      if (glass !== undefined) {
        glass.remove();
        hourglasses.delete(tag);
      } else {
        const g = el("span", { className: "ui-sprite ui-catchup", ariaHidden: "true" });
        tag.prepend(g);
        hourglasses.set(tag, g);
      }
    }
  };

  const render = (s: StageState, nextLayout: RoomLayout, selfCatching: boolean): void => {
    if (nextLayout !== layout) applyLayout(nextLayout);
    seated = s.room?.seats ?? [];
    const views = seatViews(s);
    // Chat, bubbles and playback leave seats/members untouched, so placement and the scene are only redone when they
    // change (a layout change resets drawnSeats). Slots and away follow members, so they are covered too (OME-911).
    const seatsNow = s.room?.seats;
    const membersNow = s.room?.members;
    if (seatsNow !== drawnSeats || membersNow !== drawnMembers) {
      drawnSeats = seatsNow;
      drawnMembers = membersNow;
      const placements: AvatarPlacement[] = [];
      const at = new Map<MemberId, Point>();
      placedAt = at;
      for (const v of views) {
        const p = seats[v.index];
        if (v.member !== null && p !== undefined) {
          placements.push({ id: v.member.id, avatar: v.member.avatar, at: p, z: scene.seats[v.index]?.z ?? standDepth(p), seatFacing: seatFacings[v.index] ?? null });
          at.set(v.member.id, p);
        }
      }
      const everyone = s.room?.members ?? [];
      const claimed = new Set<number>();
      for (const m of everyone) if (m.standingSlot !== undefined) claimed.add(m.standingSlot);
      const standers = everyone.filter((m) => !at.has(m.id));
      standSpots = standingPlacement(standers, claimed, standing.length, standSpots);
      for (const m of standers) {
        const i = standSpots.get(m.id);
        const p = i === undefined ? undefined : standing[i];
        if (p === undefined) continue;
        placements.push({ id: m.id, avatar: m.avatar, at: p, z: standDepth(p), seatFacing: null });
        at.set(m.id, p);
      }
      // Away dims the avatar in place; set before the update so a new avatar is made at its alpha. Seats stay.
      // Only members whose flag changed: one alpha write and draw each (ADR 0043).
      const away = awayChanges(awayIds, everyone);
      for (const id of away.off) view.setAway(id, false);
      for (const id of away.on) view.setAway(id, true);
      awayIds = away.now;
      view.update(views.map((v) => v.member !== null), placements);
    }

    for (const v of views) {
      const b = seatButtons[v.index];
      if (b === undefined) continue;
      b.dataset["occupied"] = String(v.member !== null);
      b.disabled = s.status !== "open";
      b.classList.toggle("mine", v.isSelf);
      b.ariaLabel = v.member === null ? `Seat ${String(v.index + 1)}, free` : v.isSelf ? `Seat ${String(v.index + 1)}, yours: stand up` : `Seat ${String(v.index + 1)}, taken by ${v.member.nickname}`;
    }

    // Nickname tags: exactly one per member, text only.
    const members = new Map((s.room?.members ?? []).map((m) => [m.id, m]));
    for (const [id, e] of tagEls) {
      if (members.has(id)) continue;
      e.remove();
      tagEls.delete(id);
      hourglasses.delete(e);
    }
    badges.keep(members);
    for (const m of members.values()) {
      let e = tagEls.get(m.id);
      if (e === undefined) {
        e = el("span", { className: "tag ui-tag" }, "nickname-tag");
        e.dataset["member"] = m.id;
        e.append(el("span", { className: "tag-name", textContent: m.nickname }));
        if (hiddenIds.has(m.id)) e.classList.add("is-hidden");
        tagEls.set(m.id, e);
        tags.append(e);
      }
      e.classList.toggle("self", m.id === s.self);
      // Away (OME-911): the tag is dimmed and says "Away" to screen readers; toggled only on a change.
      const isAway = m.away === true;
      if (e.classList.contains("is-away") !== isAway) {
        e.classList.toggle("is-away", isAway);
        if (isAway) e.append(el("span", { className: "sr-only tag-away", textContent: " (Away)" }));
        else e.querySelector(".tag-away")?.remove();
      }
      const p = view.position(m.id) ?? placedAt.get(m.id);
      if (p !== undefined) place(e, { x: p.x, y: p.y + TAG_OFFSET_Y });
    }

    // The state says whose bubbles show (a speaker who left, or a reconnect, takes theirs along). Every line the floats
    // haven't had yet goes to them, oldest first, even when several landed since the last render (OME-809).
    speaking.clear();
    for (const b of s.bubbles) speaking.add(b.memberId);
    floats.keep(speaking);
    handoff.hand(s.bubbles, (b) => {
      const p = view.position(b.memberId) ?? placedAt.get(b.memberId);
      const m = members.get(b.memberId);
      if (p === undefined || m === undefined) return false;
      floats.say({ id: b.memberId, name: m.nickname, text: b.text, self: b.memberId === s.self, at: { x: p.x, y: p.y - liftOf(b.memberId) }, startedAt: b.expiresAt - BUBBLE_MS });
      return true;
    });

    renderSyslines(rail, s.syslines, syslineEls);
    applyCatching(s, selfCatching);
  };

  return {
    root,
    overlay,
    tags,
    view,
    render,
    applyCatching,
    emote(id, kind, s) {
      seated = s.room?.seats ?? seated;
      // shortcut: no badge art for cheer/yawn yet; drop them until the expressions hookup issue lands.
      if (kind === "cheer" || kind === "yawn") return;
      if (!o.reducedMotion.matches) {
        view.emote(id, kind);
        return;
      }
      const p = view.position(id) ?? placedAt.get(id);
      if (p !== undefined) badges.show(id, kind, { x: p.x, y: p.y - liftOf(id) });
    },
    hide(id, hidden) {
      if (hidden) hiddenIds.add(id);
      else hiddenIds.delete(id);
      tagEls.get(id)?.classList.toggle("is-hidden", hidden);
      view.setDimmed(id, hidden);
    },
    seat: (i) => seats[i],
    anchor: (id) => view.position(id) ?? placedAt.get(id),
    head: (id) => {
      const p = view.position(id) ?? placedAt.get(id);
      return p === undefined ? undefined : { x: p.x, y: p.y - liftOf(id) };
    },
    layoutBuilds: () => layoutBuilds,
  };
}
