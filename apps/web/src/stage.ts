// The room's stage: the Pixi room (floor, furniture, seats, avatars), the seat keys over it, the nickname tags, chat
// bubbles, emote badges and the system-line rail. Drawn from the room's state on the frames the caller asks for. Made
// once per page: the room tab's (room.ts), or, with the room popped out, the room window's (popout/room-pop.ts, OME-600),
// so the window draws exactly what the page would. The caller owns what clicks on a seat do.
import { SEAT_COUNT, layoutSeats, type EmoteKind, type MemberId, type RoomLayout } from "@omega/shared";
import { el, renderSyslines } from "./controls/dom";
import { createEmoteBadges } from "./emote/badges";
import type { FurnitureAtlas } from "./furniture-atlas";
import { layoutKey as keyOfLayout, layoutOf, sceneOf, seatPoints, standDepth, standingPoints, usesSetG } from "./furniture";
import { seatViews } from "./intents";
import { BUBBLE_OFFSET_Y, SYSLINE_RAIL, TAG_OFFSET_Y, type Point, type Rect } from "./layout";
import { createRoomView, type AvatarPlacement, type RoomView } from "./room-view";
import { catchingUp, type StageState } from "./state";
import { EMOTE_LIFT } from "./walk/animator";
import { walkGrid } from "./walk/path";
import { standingSpots } from "./walk/standing";
import type { Dir } from "./walk/walks";

export interface StageOptions {
  /** Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415). */
  readonly reducedMotion: { readonly matches: boolean };
  /** Draw again on the next frame (the furniture atlas arrived). */
  readonly requestRender: () => void;
  /** The seats moved (a new layout): the phone's room window looks at their middle. */
  readonly onLayout?: (seats: readonly Point[]) => void;
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
  /** Where seat `i` is (stage px), for the phone's window. */
  seat(i: number): Point | undefined;
  /** Where a member is drawn now, or was put by the last render. */
  anchor(id: MemberId): Point | undefined;
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
  const bubbles = el("div", { className: "bubbles", ariaLive: "polite" });
  // Chat system lines ("Ana paused"): caption rail in the stage's bottom-left, text only.
  const rail = el("div", { className: "syslines", ariaLive: "polite" });
  box(rail, SYSLINE_RAIL);

  const tagEls = new Map<MemberId, HTMLElement>();
  const bubbleEls = new Map<MemberId, HTMLElement>();
  const badges = createEmoteBadges(bubbles, {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  });
  /** The seats as last drawn, for the emote lift (a sitter's sticker sits lower). */
  let seated: readonly (MemberId | null)[] = [];
  const liftOf = (id: MemberId): number => (seated.includes(id) ? EMOTE_LIFT.sit : EMOTE_LIFT.idle);
  // Tags, bubbles and emote badges ride along with a walking avatar.
  const view = await createRoomView({
    onMove: (id, x, y) => {
      badges.move(id, x, y - liftOf(id));
      const tag = tagEls.get(id);
      if (tag !== undefined) place(tag, { x, y: y + TAG_OFFSET_Y });
      const bubble = bubbleEls.get(id);
      if (bubble !== undefined) place(bubble, { x, y: y + BUBBLE_OFFSET_Y });
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
  let grid: Uint8Array = new Uint8Array(0);
  let standing: Point[] = [];
  let scene = sceneOf(layoutOf(null), null);
  /** The set (g) atlas once loaded: later layouts build their scene with it straight away. */
  let atlas: FurnitureAtlas | null = null;
  /** The drawn layout's content; a re-join snapshot parses a new but equal layout, which keeps the scene. */
  let layoutKey = "";
  let layoutBuilds = 0;
  /** Where the last render put each member (seat or standing spot), for UI anchored to someone not on screen yet. */
  let placedAt = new Map<MemberId, Point>();
  /** The hourglass on each catching tag; a tag removed with its member takes its hourglass along. */
  const hourglasses = new Map<HTMLElement, HTMLElement>();

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
    const needsAtlas = usesSetG(next);
    const ready = needsAtlas ? atlas : null;
    scene = sceneOf(next, ready?.manifest ?? null);
    view.setScene(scene, ready, grid);
    // The translate property, not transform: style.css turns the seat into the floor diamond with its transform.
    seatButtons.forEach((b, i) => {
      const p = seats[i];
      if (p !== undefined) b.style.translate = `${String(p.x)}px ${String(p.y)}px`;
    });
    drawnSeats = undefined;
    if (!needsAtlas || ready !== null) return;
    void import("./furniture-atlas")
      .then((m) => m.loadFurnitureAtlas())
      .then((loaded) => {
        atlas = loaded;
        if (layout !== next) return;
        scene = sceneOf(next, loaded.manifest);
        view.setScene(scene, loaded, grid);
        drawnSeats = undefined;
        o.requestRender();
      })
      // Without the sheet the room still works: placeholder floor, seats and avatars. The next snapshot retries.
      .catch((e: unknown) => {
        if (layout === next) layoutKey = "";
        console.warn("furniture atlas failed to load", e);
      });
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
    const placements: AvatarPlacement[] = [];
    const at = new Map<MemberId, Point>();
    placedAt = at;
    const views = seatViews(s);
    for (const v of views) {
      const p = seats[v.index];
      if (v.member !== null && p !== undefined) {
        placements.push({ id: v.member.id, avatar: v.member.avatar, at: p, z: scene.seats[v.index]?.z ?? standDepth(p), seatFacing: seatFacings[v.index] ?? null });
        at.set(v.member.id, p);
      }
    }
    const standers = (s.room?.members ?? []).filter((m) => !at.has(m.id));
    standSpots = standingSpots(standers.map((m) => m.id), standing.length, standSpots);
    for (const m of standers) {
      const i = standSpots.get(m.id);
      const p = i === undefined ? undefined : standing[i];
      if (p === undefined) continue;
      placements.push({ id: m.id, avatar: m.avatar, at: p, z: standDepth(p), seatFacing: null });
      at.set(m.id, p);
    }
    // Chat, bubbles and playback leave seats/members untouched, so the scene is only redrawn when they change.
    const seatsNow = s.room?.seats;
    const membersNow = s.room?.members;
    if (seatsNow !== drawnSeats || membersNow !== drawnMembers) {
      drawnSeats = seatsNow;
      drawnMembers = membersNow;
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
        tagEls.set(m.id, e);
        tags.append(e);
      }
      e.classList.toggle("self", m.id === s.self);
      const p = view.position(m.id) ?? at.get(m.id);
      if (p !== undefined) place(e, { x: p.x, y: p.y + TAG_OFFSET_Y });
    }

    const live = new Set(s.bubbles.map((b) => b.memberId));
    for (const [id, e] of bubbleEls) {
      if (live.has(id)) continue;
      e.remove();
      bubbleEls.delete(id);
    }
    for (const b of s.bubbles) {
      const p = view.position(b.memberId) ?? at.get(b.memberId);
      let e = bubbleEls.get(b.memberId);
      if (e === undefined) {
        e = el("p", { className: "bubble" }, "chat-message");
        bubbleEls.set(b.memberId, e);
        bubbles.append(e);
      }
      if (e.textContent !== b.text) e.textContent = b.text;
      if (p !== undefined) place(e, { x: p.x, y: p.y + BUBBLE_OFFSET_Y });
    }

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
      if (!o.reducedMotion.matches) {
        view.emote(id, kind);
        return;
      }
      const p = view.position(id) ?? placedAt.get(id);
      if (p !== undefined) badges.show(id, kind, { x: p.x, y: p.y - liftOf(id) });
    },
    seat: (i) => seats[i],
    anchor: (id) => view.position(id) ?? placedAt.get(id),
    layoutBuilds: () => layoutBuilds,
  };
}
