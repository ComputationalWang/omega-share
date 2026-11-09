// The room's stage: the Pixi room (floor, furniture, seats, avatars), the seat keys over it, the nickname tags, chat
// bubbles, emote badges and the system-line rail. Drawn from the room's state on the frames the caller asks for. Made
// once per page: the room tab's (room.ts), or, with the room popped out, the room window's (popout/room-pop.ts, OME-600),
// so the window draws exactly what the page would. The caller owns what clicks on a seat do.
import { SEAT_COUNT, type FloorCell, type MemberId, type ReactionKind, type RoomLayout } from "@omega/shared";
import type { Texture } from "pixi.js";
import { createFloats, windowToStage } from "./bubbles/floats";
import { createHandoff } from "./bubbles/handoff";
import { el, renderSyslines } from "./controls/dom";
import { createEmoteBadges } from "./emote/badges";
import { createReactionGlyphs } from "./reactions/glyphs";
import type { FurnitureAtlas } from "./furniture-atlas";
import { cutaway, doorAt, layoutOf, seatFacings as facingsOf, piecesInUse, sceneKey as keyOfLayout, sceneOf, seatPoints, seatTiles, standDepth, standingPoints, usesSetG, usesV2, usesV4, usesV5, usesV6, usesV7, usesV8, usesV8Shell, usesBack, viewVerdict } from "./furniture";
import type { RoomAtlas } from "./room-atlas";
import type { RecolourSheets } from "./recolour-sheets";
import { recolourOf, recoloursIn, type RecolourSheet } from "./recolours";
import { doubleTap, isStepKey, lieIntent, seatViews, type StepKey } from "./intents";
import { ROOM_VIEW, STAGE_W, SYSLINE_RAIL, TAG_H, TAG_MAX_SCALE, TAG_OFFSET_Y, cellCenter, isNorth, setNorth, type Point, type Rect } from "./layout";
import { createRoomView, type AvatarPlacement, type RoomSound, type RoomView } from "./room-view";
import { BUBBLE_MS, catchingUp, type StageState } from "./state";
import { EMOTE_LIFT } from "./walk/animator";
import { LIE_KEY_LIFT, lieKeyPoint } from "./walk/lie";
import { cellAt, colOf, rowOf, walkGrid } from "./walk/path";
import type { AvatarEmote } from "./walk/motion";
import { standingPlacement } from "./walk/standing";
import { awayChanges } from "./session-lifecycle";
import tintsJson from "../../../assets/avatars/tints.json";
import { AVATAR_IDS, parseTints, tintAccent } from "./walk/tint";
import type { Dir } from "./walk/walks";
import { onceAsync } from "./once";
import { mentions } from "./chat/mention";
import { placeAt } from "./tag-place";
import { TAG_GAP, createTagStacker, screenBoxes, wearPlace, type Box, type TagBox, type TagPlace } from "./tag-stack";

/** The avatars' shirt ramps (tints.json), for the tag and bubble accents (OME-1375). */
const TINTS = parseTints(tintsJson, AVATAR_IDS);

export interface StageOptions {
  /** Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415). */
  readonly reducedMotion: { readonly matches: boolean };
  /** Draw again on the next frame (the furniture atlas arrived). */
  readonly requestRender: () => void;
  /** A new layout: its seats and its standing spots (the room window looks at them, the band at both, OME-1843). */
  readonly onLayout?: (seats: readonly Point[], standing: readonly Point[]) => void;
  /** An avatar moved a whole pixel (it's walking): the emote wheel closes when it's mine (OME-732). */
  readonly onMove?: (id: MemberId) => void;
  /** An avatar came to rest (/hug arrives, OME-1453). */
  readonly onStop?: (id: MemberId) => void;
  /**
   * Free walking (OME-1350, ADR 0053): a click or tap on floor cell `cell`; `run` for the second of a double (OME-1464).
   * False when nobody can stand there: the floor flashes "can't go there". Without it the floor takes no input (the
   * pop-out room's window).
   */
  readonly onFloor?: (cell: FloorCell, run: boolean) => boolean;
  /** An arrow key on the focused floor (`repeat`: held down, `run`: with Shift); false flashes as `onFloor` does. */
  readonly onStep?: (key: StepKey, repeat: boolean, run: boolean) => boolean;
  /** S on the focused floor (OME-1501): sit on the floor or get up. */
  readonly onSit?: () => void;
  /** A layer right over the canvas, under the floor, seats, tags and bubbles: the cinema dim (OME-1406). */
  readonly dim?: HTMLElement;
  /** The room and server time (OME-1520): every client's cats wander alike from them (room-view.ts). */
  readonly roomId?: string;
  readonly serverNow?: () => number;
  /** The room's sounds (OME-1638), passed to the room view. */
  readonly sound?: RoomSound;
}

export interface Stage {
  /** The stage element (`data-testid=room`): the canvas and every layer over it, at 960×600 stage px. */
  readonly root: HTMLElement;
  /** The seat keys' layer: one `[data-seat]` button per seat, and one `[data-lie]` button (OME-1691) per piece to lie on. */
  readonly overlay: HTMLElement;
  /** The nickname tags' layer (the owner's moderation tools hang their menu off a tag). */
  readonly tags: HTMLElement;
  readonly view: RoomView;
  /** Draw `s` with `layout` (the room's, or the owner's draft); `selfCatching` is my own player's catching-up flag; while
   * `editing`, the owner editor's hit layer has the floor, so the walk floor is inert. */
  render(s: StageState, layout: RoomLayout, selfCatching: boolean, editing: boolean): void;
  /** Only the catching-up hourglasses (my player's flag changes between renders). */
  applyCatching(s: StageState, selfCatching: boolean): void;
  emote(id: MemberId, kind: AvatarEmote, s: StageState): void;
  /** Two members paired (OME-1672): the pose animation, unless reduced motion asks for stillness. */
  pair(thruster: MemberId, bender: MemberId): void;
  /** A received reaction (OME-1631): a glyph burst over their head, if the view allows it now. Returns the glyphs shown. */
  react(id: MemberId, kind: ReactionKind): number;
  /** Their next move is a teleport (OME-1548, `walked.teleport`): marked before the state change that draws it. */
  teleported(id: MemberId): void;
  /** The member started or stopped typing (OME-1390): the "…" over their head. */
  typing(id: MemberId, on: boolean): void;
  /** Everyone's dots go (a rejoin: the server doesn't say who is typing in a snapshot). */
  stopTyping(): void;
  /** "Hide for me" (OME-769): this member's tag and avatar dimmed (or not). Per change, never per frame. */
  hide(id: MemberId, hidden: boolean): void;
  /** Where seat `i` is (stage px), for the phone's window. */
  seat(i: number): Point | undefined;
  /** Where a member is drawn now, or was put by the last render. */
  anchor(id: MemberId): Point | undefined;
  /** Where a member's name tag shows (stage px, its top centre): over their head, or where it stacked (OME-2172). */
  tag(id: MemberId): Point | undefined;
  /** Every name tag as painted, its text and box in CSS px from the viewport (the e2e test contract, OME-2307). */
  tagRects(): { member: MemberId; text: string; rect: { x: number; y: number; width: number; height: number }; led: boolean }[];
  /** The reaction glyphs live now as painted: kind and box in CSS px from the viewport (e2e, OME-2307). */
  glyphRects(): { kind: ReactionKind; rect: { x: number; y: number; width: number; height: number } }[];
  /** The hover cursor as painted: its kind and box in CSS px from the viewport, or null while hidden (e2e, OME-2307). */
  cursorRect(): { kind: "free" | "mine" | "taken"; rect: { x: number; y: number; w: number; h: number } } | null;
  /** Hide the painted tags (or show them again), for e2e shots of the room without them. */
  hideTags(hidden: boolean): void;
  /** Where a member's painted tag hangs from now (stage px), for e2e walk paths: the DOM target no longer rides the walk. */
  tagAnchor(id: MemberId): Point | undefined;
  /** Where the last render put a member: where their walk in ends. */
  spot(id: MemberId): Point | undefined;
  /** The floor cell a member is on now (mid-walk: the one they are crossing), or null if not drawn. */
  cellOf(id: MemberId): FloorCell | null;
  /** The cats' cells now and a heart over the cat on one (OME-1669, room-view.ts). */
  catCells(): number[];
  petCat(cell: number): void;
  /** Bubbles are shown `k`× their size (the phone's zoomed-out room window, OME-1184). */
  labelScale(k: number): void;
  /** Bubbles keep inside stage x `x0`–`x1` and stacked tags above `y1`: the phone's room window as it settled (OME-1945, OME-2118), or the whole stage. */
  bubbleSides(x0: number, x1: number, y1: number, y0: number): void;
  /** What hangs over the room window (Room view's corner TV and shelf, OME-2349), CSS px from the window's top-left, and the window's width: bubbles keep clear of it. */
  bubbleAvoid(boxes: readonly Box[], w: number): void;
  /** Where a member's emote shows (stage px): `anchor` lifted over the head and the name tag on it (overOf). */
  head(id: MemberId): Point | undefined;
  /** How many times the furniture was rebuilt for a new layout. */
  layoutBuilds(): number;
}

/** What a lie key's name calls each piece. */
const LIE_NAMES: Readonly<Record<string, string>> = { sofa: "sofa", couch: "couch", cat: "cat bed", bed: "bed" };
/** room.css `.cinema-dim.is-on`: the dim's strength, and under the night mood, which is dark already. */
const DIM_ON = 0.45;
const DIM_NIGHT = 0.2;
/** How long the floor's cursor shows "can't go there" after a blocked click or step. */
const NO_GO_MS = 400;
/** How long the status note says it: longer, for screen readers that poll live regions late (OME-1364). */
const NO_GO_NOTE_MS = 1500;
/** How long a walker stands before its tag stacks with the others (OME-2213): past the /conga step (360 ms). */
const TAG_SETTLE_MS = 500;

function box(e: HTMLElement, r: Rect): void {
  Object.assign(e.style, { left: `${String(r.x)}px`, top: `${String(r.y)}px`, width: `${String(r.w)}px`, height: `${String(r.h)}px` });
}

export async function createStage(o: StageOptions): Promise<Stage> {
  // .ui-room: set (e)/(c) chrome inside the stage is at the room's 1× art scale.
  const root = el("div", { className: "stage ui-room" }, "room");
  // Every room opens from the south (OME-1961); the view turns once my avatar is behind a partition.
  setNorth(false);
  root.dataset["view"] = "south";
  const overlay = el("div", { className: "overlay" });
  // Placed from the room's layout on each render that changes it (applyLayout).
  const seatButtons = Array.from({ length: SEAT_COUNT }, (_, i) => {
    const b = el("button", { type: "button", className: "seat" }, "seat");
    b.dataset["seat"] = String(i);
    return b;
  });
  overlay.append(...seatButtons);
  // Lie keys (OME-1691): one per sofa, couch or cat bed of the layout, rebuilt on a layout change; `data-lie` is the piece's index.
  let lieButtons: { readonly b: HTMLButtonElement; readonly piece: number; readonly down: string; readonly up: string }[] = [];
  // Free walking (OME-1350): the floor under the seat keys, tags and bubbles takes clicks, taps and (focused) arrow keys.
  const floorHit = o.onFloor === undefined ? null : el("div", { className: "walk-floor", tabIndex: -1, role: "application", ariaLabel: "Room floor. Arrow keys walk your avatar one cell; with Shift, jog. S sits down or gets up." }, "walk-floor");
  const floorNote = el("span", { className: "sr-only", role: "status" });
  const tags = el("div", { className: "tags" });
  // Decorative (createFloats makes it aria-hidden): the chat log is the accessible record of what was said.
  const bubbles = el("div", { className: "bubbles" });
  // Chat system lines ("Ana paused"): caption rail in the stage's bottom-left, text only. Visual only (OME-1246): the
  // chat log says each line already, so a screen reader hears it once.
  const rail = el("div", { className: "syslines", ariaHidden: "true" });
  box(rail, SYSLINE_RAIL);

  const tagEls = new Map<MemberId, HTMLElement>();
  /** Each tag's hit pad (room.css `.tag-pad`, OME-1239): ahead of every tag in `.tags`, so a drawn tag always wins a click. */
  const padEls = new Map<MemberId, HTMLElement>();
  /** Members I hid (OME-769): their tags are made dimmed too. */
  const hiddenIds = new Set<MemberId>();
  /** Overlapping tags stack (OME-2118): each tag's width (layout px, from a ResizeObserver) and where it was moved. */
  const tagW = new Map<Element, number>();
  /** Who is mid-walk: their tag rides just over their head (aboveHead) and the others stack again once they stop. */
  const walkers = new Set<MemberId>();
  /** A stopped walker's tag stacks once it's stood TAG_SETTLE_MS: a /conga follower steps every 360 ms, and stacking
   * it at each stop flipped its pip (a full repaint) twice a step (OME-2213). */
  const settling = new Map<MemberId, ReturnType<typeof setTimeout>>();
  const tagAt = new Map<MemberId, TagPlace>();
  /** The place each tag and hit pad last wore (wearPlace). */
  const worn = new WeakMap<object, TagPlace>();
  /** The phone's readable-zoom label scale (room.css --label-scale), capped at TAG_MAX_SCALE: tags show this many times their layout size. */
  let labelK = 1;
  /** The phone window's bottom (stage px; Infinity off the phone): a stacked tag never drops past it or the room's. */
  let shownBottom = Infinity;
  /** …and its top (-Infinity off the phone): a tag never rises past it (OME-2149). */
  let shownTop = -Infinity;
  /** The room's screen as drawn (stage px, OME-2196): tags keep off it. Set with each scene. */
  let screens: readonly Box[] = [];
  /** What hangs over the room window, in its CSS px, and the window's width (bubbleAvoid); the window's sides and top in stage px (bubbleSides). */
  let over: { readonly boxes: readonly Box[]; readonly w: number } = { boxes: [], w: 0 };
  let win = { x0: 0, x1: STAGE_W, y0: ROOM_VIEW.y };
  const avoidOver = (): void => {
    floats.avoid(windowToStage(over.boxes, over.w, win.x0, win.x1, win.y0));
  };
  /** `dom`: place the DOM target and hit pad too; on a walk frame only the host's pickable ones (OME-2135, OME-2307: elsewhere
   * the painted tag rides the walk and the render places the targets). True when the painted tag moved. */
  // The stack's move is a margin, so `translate` stays the avatar's anchor (the walk e2e reads a tag's cell from it).
  const placeTag = (id: MemberId, x: number, y: number, dom: boolean): boolean => {
    const at = { x, y: y + TAG_OFFSET_Y };
    anchors.set(id, at);
    const moved = tagAt.get(id) ?? aboveHead(id);
    const tag = tagEls.get(id);
    if (tag === undefined) return false;
    const targets = dom || tags.classList.contains("pickable");
    if (targets) {
      placeAt(tag, at.x, at.y);
      wearPlace(tag, moved, worn, false);
    }
    const padEl = targets ? padEls.get(id) : undefined;
    if (padEl !== undefined) {
      placeAt(padEl, at.x, at.y);
      wearPlace(padEl, moved, worn, false);
    }
    return view.tags.place(id, at.x + moved.dx - (labelK * (tagW.get(tag) ?? 0)) / 2, at.y + moved.dy, labelK, moved.led, moved.dy < 0);
  };
  /** Paint each tag as its DOM target looks (OME-2307): name, self, tint, hidden/away, catching, and its measured width. */
  const paintTags = (): boolean => {
    let changed = false;
    for (const [id, e] of tagEls) {
      const w = tagW.get(e) ?? 0;
      const look = {
        text: e.querySelector(".tag-name")?.textContent ?? "",
        self: e.classList.contains("self"),
        tint: e.style.getPropertyValue("--tint"),
        alpha: e.classList.contains("is-hidden") ? 0.5 : e.classList.contains("is-away") ? 0.6 : 1,
        catching: e.classList.contains("catching"),
        w,
        nameW: nameW.get(e) ?? w,
      };
      if (view.tags.look(id, look)) changed = true;
    }
    return changed;
  };
  /** Where each painted tag hangs from (stage px: its owner's point, TAG_OFFSET_Y down), for e2e walk paths. */
  const anchors = new Map<MemberId, Point>();
  const stack = createTagStacker();
  /** Stack the tags of everyone standing still and place every tag. */
  const restack = (): void => {
    let moved = paintTags();
    const ids: MemberId[] = [];
    const at: Point[] = [];
    const boxes: TagBox[] = [];
    for (const [id, tag] of tagEls) {
      const p = view.position(id) ?? placedAt.get(id);
      if (p === undefined) continue;
      // A walker's tag rides over its head, unstacked (OME-2213: stacked, it'd flip its pip as it passes heads), and the
      // still tags don't stack around a walker's head either: a render where only walkers changed restacks nothing (OME-2317).
      if (walkers.has(id)) {
        tagAt.set(id, aboveHead(id));
        if (placeTag(id, p.x, p.y, true)) moved = true;
        continue;
      }
      ids.push(id);
      at.push(p);
      boxes.push({ x: p.x, y: p.y + TAG_OFFSET_Y, w: (tagW.get(tag) ?? 0) * labelK, top: p.y - headOf(id) });
    }
    const places = stack(boxes, TAG_H * labelK, Math.min(ROOM_VIEW.y + ROOM_VIEW.h, shownBottom), shownTop, screens);
    // The still tags as placed: bubbles rise past them (OME-2349).
    const placed = new Map<MemberId, Box>();
    ids.forEach((id, i) => {
      const p = at[i];
      const m = places[i];
      if (m === undefined) tagAt.delete(id);
      else tagAt.set(id, m);
      if (p === undefined) return;
      if (placeTag(id, p.x, p.y, true)) moved = true;
      const b = boxes[i];
      const place = m ?? aboveHead(id);
      if (b !== undefined) placed.set(id, { x0: b.x + place.dx - b.w / 2, x1: b.x + place.dx + b.w / 2, y0: b.y + place.dy, y1: b.y + place.dy + TAG_H * labelK });
    });
    floats.tags(placed);
    // Off a walk frame the canvas has to draw the tags' new places itself (a restack that changed nothing draws nothing).
    if (moved) view.redraw();
  };
  /** Each tag's name box width (layout px) when the DOM cut its name, else Infinity: the painted name ellipsizes to it. */
  const nameW = new Map<Element, number>();
  // A tag's text is set once, so this fires when it's added, and when an hourglass or "Away" changes its width.
  const tagSizes = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = e.borderBoxSize[0]?.inlineSize;
      if (w !== undefined) tagW.set(e.target, w);
      // Layout is clean in a ResizeObserver callback: these reads cost no reflow. Only a name the DOM cut is cut.
      const name = e.target.querySelector<HTMLElement>(".tag-name");
      if (name !== null) nameW.set(e.target, name.scrollWidth > name.clientWidth ? name.clientWidth : Infinity);
    }
    restack();
  });
  const timers = {
    setTimer: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimer: (h: unknown): void => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };
  const floats = createFloats(bubbles, { reducedMotion: o.reducedMotion, now: () => Date.now(), ...timers });
  const handoff = createHandoff();
  const speaking = new Set<MemberId>();
  /** Who shows typing dots, so a member who left takes theirs along. */
  const typers = new Set<MemberId>();
  const setTyping = (id: MemberId, on: boolean): void => {
    const p = view.position(id) ?? placedAt.get(id);
    if (on && p === undefined) return;
    floats.typing(id, on, { x: p?.x ?? 0, y: (p?.y ?? 0) - overOf(id) });
    if (on) typers.add(id);
    else typers.delete(id);
  };
  const badges = createEmoteBadges(bubbles, timers);
  /** The seats as last drawn, for the emote lift (a sitter's sticker sits lower). */
  let seated: readonly (MemberId | null)[] = [];
  /** Who sits on the floor as last drawn (OME-1501): their sticker and bubbles sit lower too. */
  let floorSat: ReadonlySet<MemberId> = new Set();
  /** Who arrives by a teleport pad (OME-1548) in the next placement; cleared once placed. */
  const teleporting = new Set<MemberId>();
  const liftOf = (id: MemberId): number => (seated.includes(id) || floorSat.has(id) ? EMOTE_LIFT.sit : EMOTE_LIFT.idle);
  /** A still tag's head top over its owner's point: a sitter's drawn hair or hat (OME-2252: the nominal lift left their tags
   * 8–13 px over it and the front row's on the back row's chairs), else the nominal lift. */
  const headOf = (id: MemberId): number => (seated.includes(id) || floorSat.has(id) ? (view.headLift(id) ?? EMOTE_LIFT.sit) : EMOTE_LIFT.idle);
  /** A tag's place unstacked (a walker's): TAG_GAP over its owner's head (OME-2172). */
  const aboveHead = (id: MemberId): TagPlace => ({ dx: 0, dy: -(liftOf(id) + TAG_OFFSET_Y + TAG_GAP + TAG_H * labelK), led: false });
  /** Bubbles, badges and the emote wheel float over the head and the tag on it. */
  const overOf = (id: MemberId): number => liftOf(id) + TAG_GAP + TAG_H * labelK;
  // Tags, bubbles and emote badges ride along with a walking avatar; a bubble's tail tips just over the head.
  const view = await createRoomView({
    ...(o.roomId === undefined ? {} : { roomId: o.roomId }),
    ...(o.serverNow === undefined ? {} : { serverNow: o.serverNow }),
    ...(o.sound === undefined ? {} : { sound: o.sound }),
    onMove: (id, x, y) => {
      const head = y - overOf(id);
      badges.move(id, x, head);
      floats.move(id, x, head);
      clearTimeout(settling.get(id));
      settling.delete(id);
      if (!walkers.has(id)) {
        walkers.add(id);
        tagAt.set(id, aboveHead(id));
        // Its DOM target stays put while the painted tag walks: the glyphs on it (hourglass, mute) wait for it (room.css).
        tagEls.get(id)?.classList.add("walking");
      }
      placeTag(id, x, y, false);
      // My drawn avatar stepped onto another cell: the next render re-judges the view (a few per walk, not per frame).
      if (id === myId) {
        const c = cellAt({ x, y });
        if (c >= 0 && c !== myCell) {
          myCell = c;
          o.requestRender();
        }
      }
      o.onMove?.(id);
    },
    onStop: (id, x, y) => {
      floats.settle(id, x, y - overOf(id));
      clearTimeout(settling.get(id));
      settling.set(
        id,
        setTimeout(() => {
          settling.delete(id);
          walkers.delete(id);
          restack();
          tagEls.get(id)?.classList.remove("walking");
        }, TAG_SETTLE_MS),
      );
      o.onStop?.(id);
    },
  });
  const glyphs = createReactionGlyphs(view.glyphs, { allowed: () => view.reactionsAllowed(), now: () => performance.now(), ...timers });
  view.canvas.className = "scene";
  // The picture only: who is here and what they say is in the people list and the chat log (OME-1246).
  view.canvas.ariaHidden = "true";
  root.append(view.canvas, ...(o.dim === undefined ? [] : [o.dim]), ...(floorHit === null ? [] : [floorHit, floorNote]), overlay, tags, bubbles, rail);
  // The cinema dim's layer (cinema.ts) keeps its spread past the stage; over the stage the scene paints it, under the tags
  // (OME-2307). Its class and mood flip on play, pause, the editor and a mood change: never per frame.
  const dimEl = o.dim;
  if (dimEl !== undefined) {
    const sync = (): void => {
      view.dim(dimEl.classList.contains("is-on") ? (dimEl.dataset["mood"] === "night" ? DIM_NIGHT : DIM_ON) : 0);
    };
    new MutationObserver(sync).observe(dimEl, { attributes: true, attributeFilter: ["class", "data-mood"] });
    sync();
  }
  // A touch screen's compat events can claim pointerType "mouse" (OME-2408): gate on the device, as the CSS :hover tint did.
  const canHover = globalThis.matchMedia("(hover: hover)");
  if (floorHit !== null) {
    /** Stage px under the pointer: the stage is CSS-scaled (and zoomed on a phone). */
    const cellUnder = (ev: MouseEvent): FloorCell | null => {
      const r = floorHit.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const k = floorHit.offsetWidth / r.width;
      const c = cellAt({ x: (ev.clientX - r.left) * k, y: (ev.clientY - r.top) * k });
      return c < 0 ? null : { x: colOf(c), y: rowOf(c) };
    };
    let noGo: ReturnType<typeof setTimeout> | undefined;
    let noGoNote: ReturnType<typeof setTimeout> | undefined;
    const flash = (): void => {
      clearTimeout(noGo);
      clearTimeout(noGoNote);
      floorHit.classList.add("no-go");
      floorNote.textContent = "You can't go there.";
      noGo = setTimeout(() => {
        floorHit.classList.remove("no-go");
      }, NO_GO_MS);
      noGoNote = setTimeout(() => {
        floorNote.textContent = "";
      }, NO_GO_NOTE_MS);
    };
    let hover: FloorCell | null = null;
    floorHit.addEventListener("pointermove", (ev) => {
      // A finger has no hover: a tap walks, a drag pans the phone's room window.
      if (ev.pointerType === "touch" || !canHover.matches) return;
      const c = cellUnder(ev);
      if (cursorOwner === "floor" && c?.x === hover?.x && c?.y === hover?.y) return;
      hover = c;
      cursorOwner = c === null ? null : "floor";
      view.marker(c === null ? null : cellCenter(c.x, c.y), "free");
    });
    floorHit.addEventListener("pointerleave", () => {
      hover = null;
      if (cursorOwner !== "floor") return;
      cursorOwner = null;
      view.marker(null, "free");
    });
    let lastTap: { cell: FloorCell; at: number } | null = null;
    floorHit.addEventListener("click", (ev) => {
      const c = cellUnder(ev);
      if (c === null) return;
      // A double-click or double-tap jogs (OME-1464); a third click starts a new pair.
      const run = doubleTap(lastTap, c, ev.timeStamp);
      lastTap = run ? null : { cell: c, at: ev.timeStamp };
      if (o.onFloor?.(c, run) === false) flash();
    });
    floorHit.addEventListener("keydown", (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "s" || ev.key === "S") {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) o.onSit?.();
        return;
      }
      if (!isStepKey(ev.key)) return;
      // Taken here: the page doesn't scroll, and the room's own keys don't also run.
      ev.preventDefault();
      ev.stopPropagation();
      if (o.onStep?.(ev.key, ev.repeat, ev.shiftKey) === false) flash();
    });
  }

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
  let scene = sceneOf(layoutOf(null), []);
  /** The set (g) atlas once loaded: later layouts build their scene with it straight away. */
  let atlas: FurnitureAtlas | null = null;
  /** Catalogue v2's atlas once loaded (OME-1113); same shape as set (g)'s. */
  let v2Atlas: FurnitureAtlas | null = null;
  /** Batch 6's atlas once loaded (OME-1439); same shape again. */
  let v4Atlas: FurnitureAtlas | null = null;
  /** The theatre set's atlas once loaded (OME-1630); same shape again. */
  let v5Atlas: FurnitureAtlas | null = null;
  /** The Dank Dungeon's atlas once loaded (OME-1672). */
  let v6Atlas: FurnitureAtlas | null = null;
  /** The reworked dungeon's v7 atlas once loaded (OME-1991): its pieces, v7 colours and shell skin. */
  let v7Atlas: FurnitureAtlas | null = null;
  /** Wave 2's v8 atlas once loaded (OME-2069): the wall screens. */
  let v8Atlas: FurnitureAtlas | null = null;
  /** The penthouse and studio shell skins once loaded (OME-2455). */
  let v8ShellAtlas: FurnitureAtlas | null = null;
  /** The room atlas (planks, walls, room-atlas kinds) once loaded; every room uses it. */
  let roomAtlas: RoomAtlas | null = null;
  /** The new colours' sheet copies (OME-1463), once a layout used one; `recolouring` names the copies asked for. */
  let recolours: RecolourSheets | null = null;
  const recolouring = new Set<string>();
  // One instance for every copy: two copies loading at once each made their own, and one copy was lost (OME-1495).
  const recolourChunk = onceAsync(async () => (recolours = (await import("./recolour-sheets")).recolourSheets()));
  /** The drawn layout's content; a re-join snapshot parses a new but equal layout, which keeps the scene. */
  let layoutKey = "";
  let layoutBuilds = 0;
  /** Where the last render put each member (seat or standing spot), for UI anchored to someone not on screen yet. */
  let placedAt = new Map<MemberId, Point>();
  /** The cells people stand on and sit on, and whether a video played, as the furniture in use was last worked out (OME-1407). */
  let standCells = new Set<number>();
  let sitCells = new Set<number>();
  let inUseStale = true;
  /** My avatar is behind the partition (OME-1960): for me only, the room turns north (OME-1961) or, until the back sheet is in, its partitions draw cut down. */
  let behind = false;
  let cut = false;
  /** My avatar's cell as drawn (OME-2346: not its walk's end, so the view turns as it passes the doorway), for the view verdict; null with no avatar. */
  let myCell: number | null = null;
  let myId: MemberId | null = null;
  /** Where my walk ends (the server's cell): on the doorway line my drawn avatar already counts as behind if it is heading there. */
  let myGoal: number | null = null;
  /** The back-view atlas once loaded (OME-1961): turned one-sided pieces and the north shell skin. */
  let backAtlas: FurnitureAtlas | null = null;
  let drawnPlaying = false;
  /** The hourglass on each catching tag; a tag removed with its member takes its hourglass along. */
  const hourglasses = new Map<HTMLElement, HTMLElement>();

  const buildScene = (l: RoomLayout): void => {
    const catalogues = [atlas, v2Atlas, v4Atlas, v5Atlas, v6Atlas, v7Atlas, v8Atlas, v8ShellAtlas].flatMap((a) => (a === null ? [] : [a.manifest]));
    scene = sceneOf(l, catalogues, roomAtlas?.manifest ?? null, backAtlas?.manifest ?? null);
    const sheets = [atlas, v2Atlas, v4Atlas, v5Atlas, v6Atlas, v7Atlas, v8Atlas, v8ShellAtlas, backAtlas, roomAtlas, recolours];
    view.setScene(scene, sheets, grid);
    drawnSeats = undefined;
    screens = screenBoxes(scene.sprites, (key) => {
      const t = sheets.reduce<Texture | undefined>((found, sheet) => found ?? sheet?.texture(key), undefined);
      return t === undefined ? undefined : { w: t.width, h: t.height, ax: t.defaultAnchor?.x ?? 0, ay: t.defaultAnchor?.y ?? 0 };
    });
    restack();
  };

  const sourceOf = (sheet: RecolourSheet): FurnitureAtlas | RoomAtlas | null =>
    sheet === "room/room.png" ? roomAtlas : sheet === "furniture/furniture.png" ? atlas : sheet === "furniture/furniture-v2.png" ? v2Atlas : sheet === "furniture/furniture-v8.png" ? v8Atlas : v4Atlas;

  /** The copies `l`'s new colours draw from, each once its source atlas is in; the chunk loads only for a layout with one. */
  const loadRecolours = (key: string, l: RoomLayout): void => {
    for (const { kind, variant } of recoloursIn(l)) {
      const id = `${kind}/${String(variant)}`;
      const r = recolourOf(kind, variant);
      const source = r === undefined ? null : sourceOf(r.sheet);
      if (source === null || recolouring.has(id)) continue;
      recolouring.add(id);
      const load = async (): Promise<void> => {
        await (await recolourChunk()).load(kind, variant, source);
      };
      // A failed copy (chunk or sheet) is forgotten, so the next snapshot retries it.
      lazyAtlas("recolour", key, l, () => load().catch((e: unknown) => {
        recolouring.delete(id);
        throw e;
      }), () => undefined);
    }
  };

  /** Load an atlas in its own chunk, then rebuild the scene if the room still shows `key`'s layout. */
  const lazyAtlas = <T>(what: string, key: string, l: RoomLayout, load: () => Promise<T>, keep: (loaded: T) => void): void => {
    void load()
      .then((loaded) => {
        keep(loaded);
        if (layoutKey !== key) return;
        loadRecolours(key, l);
        buildScene(l);
        o.requestRender();
      })
      // Without the sheet the room still works: placeholder floor, seats and avatars. The next snapshot retries.
      .catch((e: unknown) => {
        if (layoutKey === key) layoutKey = "";
        console.warn(`${what} atlas failed to load`, e);
      });
  };

  // The hover cursor (OME-2307): the floor's hover cell or a seat key's, painted by the view; the last to write owns it.
  let cursorOwner: "floor" | number | null = null;
  let seatTilePts: readonly Point[] = [];
  const showSeatCursor = (i: number): void => {
    const b = seatButtons[i];
    const at = seatTilePts[i];
    if (b === undefined || at === undefined) return;
    cursorOwner = i;
    view.marker(at, b.classList.contains("mine") ? "mine" : b.dataset["occupied"] === "true" ? "taken" : "free");
  };
  const hideSeatCursor = (i: number): void => {
    if (cursorOwner !== i) return;
    cursorOwner = null;
    view.marker(null, "free");
  };
  seatButtons.forEach((b, i) => {
    // A finger has no hover: a tap's sticky enter must not leave the cursor over the sitter (OME-2175).
    b.addEventListener("pointerenter", (ev) => {
      if (ev.pointerType !== "touch" && canHover.matches) showSeatCursor(i);
    });
    b.addEventListener("focus", () => {
      if (b.matches(":focus-visible")) showSeatCursor(i);
    });
    b.addEventListener("pointerleave", () => {
      hideSeatCursor(i);
    });
    b.addEventListener("blur", () => {
      hideSeatCursor(i);
    });
  });
  /** Rebuild furniture, seats and standing spots for a new layout; the set (g) atlas loads only if the layout needs it. */
  const applyLayout = (next: RoomLayout): void => {
    layout = next;
    const key = keyOfLayout(next);
    if (key === layoutKey) return;
    layoutKey = key;
    layoutBuilds++;
    seats = seatPoints(next);
    standing = standingPoints(next);
    o.onLayout?.(seats, standing);
    seatFacings = facingsOf(next);
    grid = walkGrid(next);
    buildScene(next);
    // The translate property, not transform: style.css turns the seat into the floor diamond with its transform. Keys sit
    // on the tile, not the lifted sitter: a riser's 44 px phone key would otherwise cover the row in front (QA OME-1743).
    const tiles = seatTiles(next);
    seatTilePts = tiles;
    if (typeof cursorOwner === "number") showSeatCursor(cursorOwner);
    seatButtons.forEach((b, i) => {
      const p = tiles[i];
      if (p !== undefined) b.style.translate = `${String(p.x)}px ${String(p.y)}px`;
    });
    for (const k of lieButtons) k.b.remove();
    lieButtons = next.furniture.flatMap((f, i) => {
      // The bed's key sits on a footprint cell (cellCenter follows the view); a sofa's is above the first lier's spot in
      // my view (OME-1961: from the north the piece is turned, so its south-view offset doesn't apply).
      const spot = scene.lies.get(i)?.[0];
      const p = f.kind === "bed" ? lieKeyPoint(f) : spot && { x: spot.at.x, y: spot.at.y - LIE_KEY_LIFT };
      if (p === undefined) return [];
      const b = el("button", { type: "button", className: "lie-key" }, "lie-key");
      b.dataset["lie"] = String(i);
      b.style.translate = `${String(p.x)}px ${String(p.y)}px`;
      const name = LIE_NAMES[f.kind] ?? "sofa";
      return [{ b, piece: i, down: `Lie down on the ${name}`, up: `Get up from the ${name}` }];
    });
    overlay.append(...lieButtons.map((k) => k.b));
    loadRecolours(key, next);
    if (roomAtlas === null) {
      lazyAtlas("room", key, next, () => import("./room-atlas").then((m) => m.loadRoomAtlas()), (a) => (roomAtlas = a));
    }
    if (usesSetG(next) && atlas === null) {
      lazyAtlas("furniture", key, next, () => import("./furniture-atlas").then((m) => m.loadFurnitureAtlas()), (a) => (atlas = a));
    }
    if (usesV2(next) && v2Atlas === null) {
      lazyAtlas("furniture v2", key, next, () => import("./furniture-v2-atlas").then((m) => m.loadFurnitureV2Atlas()), (a) => (v2Atlas = a));
    }
    if (usesV6(next) && v6Atlas === null) {
      lazyAtlas("furniture v6", key, next, () => import("./furniture-v6-atlas").then((m) => m.loadFurnitureV6Atlas()), (a) => (v6Atlas = a));
    }
    if (usesV7(next) && v7Atlas === null) {
      lazyAtlas("furniture v7", key, next, () => import("./furniture-v7-atlas").then((m) => m.loadFurnitureV7Atlas()), (a) => (v7Atlas = a));
    }
    if (usesV8(next) && v8Atlas === null) {
      lazyAtlas("furniture v8", key, next, () => import("./furniture-v8-atlas").then((m) => m.loadFurnitureV8Atlas()), (a) => (v8Atlas = a));
    }
    if (usesV8Shell(next) && v8ShellAtlas === null) {
      lazyAtlas("furniture v8 shell", key, next, () => import("./furniture-v8-shell-atlas").then((m) => m.loadFurnitureV8ShellAtlas()), (a) => (v8ShellAtlas = a));
    }
    if (usesBack(next) && backAtlas === null) {
      lazyAtlas("furniture back", key, next, () => import("./furniture-back-atlas").then((m) => m.loadFurnitureBackAtlas()), (a) => (backAtlas = a));
    }
    if (next.pairs === true) view.loadPairPoses();
    if (usesV4(next) && v4Atlas === null) {
      lazyAtlas("furniture v4", key, next, () => import("./furniture-v4-atlas").then((m) => m.loadFurnitureV4Atlas()), (a) => (v4Atlas = a));
    }
    if (usesV5(next) && v5Atlas === null) {
      lazyAtlas("furniture v5", key, next, () => import("./furniture-v5-atlas").then((m) => m.loadFurnitureV5Atlas()), (a) => (v5Atlas = a));
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

  const render = (s: StageState, nextLayout: RoomLayout, selfCatching: boolean, editing: boolean): void => {
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
      const everyone = s.room?.members ?? [];
      const at = new Map<MemberId, Point>();
      const before = placedAt;
      placedAt = at;
      // Someone new (in my first snapshot, only me) on a door's front cell walked in through it (OME-1558, `join.via`).
      const throughDoor = (id: MemberId, cell: FloorCell): boolean => !before.has(id) && (before.size > 0 || id === s.self) && doorAt(nextLayout, cell.x, cell.y) !== null;
      // Lying (OME-1691): on the piece's spot, in its facing, drawn between its back and front; they hold no seat, and their cell is where they get up to.
      for (const m of everyone) {
        const spot = m.lying === undefined ? undefined : scene.lies.get(m.lying)?.[m.sleeper ?? 0];
        if (spot === undefined) continue;
        const cover = spot.cover === undefined ? {} : { cover: { ...spot.cover, at: spot.anchor } };
        placements.push({ id: m.id, avatar: m.avatar, tint: m.tint ?? 0, hair: m.hair ?? 0, accessory: m.accessory ?? 0, at: spot.at, z: spot.z, seatFacing: spot.dir, lie: spot.style, ...cover });
        at.set(m.id, spot.at);
      }
      for (const v of views) {
        const p = seats[v.index];
        if (v.member !== null && p !== undefined && !at.has(v.member.id)) {
          // A lounger's sitter lies back on it (OME-2123): their floor point is the lier's, their depth still the seat's.
          const lie = scene.seats[v.index]?.lie;
          const q = lie?.at ?? p;
          placements.push({ id: v.member.id, avatar: v.member.avatar, tint: v.member.tint ?? 0, hair: v.member.hair ?? 0, accessory: v.member.accessory ?? 0, at: q, z: scene.seats[v.index]?.z ?? standDepth(p), seatFacing: seatFacings[v.index] ?? null, ...(lie === undefined ? {} : { lie: lie.style }) });
          at.set(v.member.id, q);
        }
      }
      // Someone who walked somewhere stands on that cell (ADR 0053); a seat wins if both ever showed.
      for (const m of everyone) {
        if (m.cell === undefined || at.has(m.id)) continue;
        const p = cellCenter(m.cell.x, m.cell.y);
        placements.push({ id: m.id, avatar: m.avatar, tint: m.tint ?? 0, hair: m.hair ?? 0, accessory: m.accessory ?? 0, at: p, z: standDepth(p), seatFacing: null, run: s.running.includes(m.id), floorSit: m.floorSit === true, ...(teleporting.has(m.id) ? { teleport: true } : {}), ...(throughDoor(m.id, m.cell) ? { door: true } : {}) });
        at.set(m.id, p);
      }
      // Sitting down or getting up in place moves no pixel, so no onMove: drop or lift their bubbles and badge here.
      const wasSat = floorSat;
      floorSat = new Set(everyone.flatMap((m) => (m.floorSit === true && m.cell !== undefined ? [m.id] : [])));
      for (const id of new Set([...wasSat, ...floorSat])) {
        if (wasSat.has(id) === floorSat.has(id)) continue;
        const p = view.position(id) ?? at.get(id);
        if (p === undefined) continue;
        badges.move(id, p.x, p.y - overOf(id));
        floats.move(id, p.x, p.y - overOf(id));
      }
      const claimed = new Set<number>();
      for (const m of everyone) if (m.standingSlot !== undefined) claimed.add(m.standingSlot);
      const standers = everyone.filter((m) => !at.has(m.id));
      standSpots = standingPlacement(standers, claimed, standing.length, standSpots);
      for (const m of standers) {
        const i = standSpots.get(m.id);
        const p = i === undefined ? undefined : standing[i];
        if (p === undefined) continue;
        placements.push({ id: m.id, avatar: m.avatar, tint: m.tint ?? 0, hair: m.hair ?? 0, accessory: m.accessory ?? 0, at: p, z: standDepth(p), seatFacing: null });
        at.set(m.id, p);
      }
      // Away dims the avatar in place; set before the update so a new avatar is made at its alpha. Seats stay.
      // Only members whose flag changed: one alpha write and draw each (ADR 0043).
      const away = awayChanges(awayIds, everyone);
      for (const id of away.off) view.setAway(id, false);
      for (const id of away.on) view.setAway(id, true);
      awayIds = away.now;
      view.update(views.map((v) => v.member !== null), placements);
      teleporting.clear();
      standCells = new Set(placements.flatMap((p) => (p.seatFacing === null ? [cellAt(p.at)] : [])));
      sitCells = new Set(placements.flatMap((p) => (p.seatFacing === null ? [] : [cellAt(p.at)])));
      const mine = placements.find((p) => p.id === s.self);
      myId = mine === undefined ? null : mine.id;
      myCell = mine === undefined ? null : cellAt(view.position(mine.id) ?? mine.at);
      myGoal = mine === undefined ? null : cellAt(mine.at);
      inUseStale = true;
    }
    // Per render, not per placement: the editor opening turns the view south (OME-1961). Cheap: one find over the furniture.
    // Walking north, past the doorway's middle my avatar is drawn behind the next partition piece from the south (QA OME-2352): turn as it steps in.
    const verdict = viewVerdict(nextLayout, myCell, behind || cutaway(nextLayout, myGoal, behind), editing, backAtlas !== null);
    behind = verdict.behind;
    if (verdict.cut !== cut) {
      cut = verdict.cut;
      inUseStale = true;
    }
    if (verdict.north !== isNorth()) {
      // The 180° swap: everyone's drawn spot turns with the room (no walk), then the layout is rebuilt once in the new projection.
      setNorth(verdict.north);
      root.dataset["view"] = verdict.north ? "north" : "south";
      view.reflect();
      layoutKey = "";
      applyLayout(nextLayout);
      o.requestRender();
    }
    const playing = s.room?.playback?.playing === true;
    if (inUseStale || playing !== drawnPlaying) {
      inUseStale = false;
      drawnPlaying = playing;
      view.setInUse(piecesInUse(nextLayout, standCells, playing, sitCells, cut));
    }
    // A cat waits rather than walk into someone standing; the editor keeps it home. Cheap: it acts on a freeze change only.
    view.setCatRules(standCells, editing);
    if (floorHit !== null) {
      const tab = s.status === "open" ? 0 : -1;
      if (floorHit.tabIndex !== tab) floorHit.tabIndex = tab;
      if (floorHit.inert !== editing) floorHit.inert = editing;
    }

    for (const v of views) {
      const b = seatButtons[v.index];
      if (b === undefined) continue;
      b.dataset["occupied"] = String(v.member !== null);
      b.disabled = s.status !== "open";
      b.classList.toggle("mine", v.isSelf);
      if (cursorOwner === v.index) showSeatCursor(v.index);
      b.ariaLabel = v.member === null ? `Seat ${String(v.index + 1)}, free` : v.isSelf ? `Seat ${String(v.index + 1)}, yours: stand up` : `Seat ${String(v.index + 1)}, taken by ${v.member.nickname}`;
    }

    for (const { b, piece, down, up } of lieButtons) {
      const mine = s.room?.members.some((m) => m.id === s.self && m.lying === piece) === true;
      b.disabled = lieIntent(s, piece) === null;
      b.classList.toggle("mine", mine);
      b.ariaLabel = mine ? up : down;
    }

    // Nickname tags: exactly one per member, text only.
    const members = new Map((s.room?.members ?? []).map((m) => [m.id, m]));
    for (const [id, e] of tagEls) {
      if (members.has(id)) continue;
      e.remove();
      tagSizes.unobserve(e);
      tagW.delete(e);
      tagAt.delete(id);
      walkers.delete(id);
      clearTimeout(settling.get(id));
      settling.delete(id);
      tagEls.delete(id);
      nameW.delete(e);
      anchors.delete(id);
      view.tags.drop(id);
      padEls.get(id)?.remove();
      padEls.delete(id);
      hourglasses.delete(e);
    }
    badges.keep(members);
    for (const id of typers) if (!members.has(id)) setTyping(id, false);
    for (const m of members.values()) {
      let e = tagEls.get(m.id);
      if (e === undefined) {
        e = el("span", { className: "tag ui-tag" }, "nickname-tag");
        e.dataset["member"] = m.id;
        e.append(el("span", { className: "tag-name", textContent: m.nickname }));
        if (hiddenIds.has(m.id)) e.classList.add("is-hidden");
        tagEls.set(m.id, e);
        tags.append(e);
        tagSizes.observe(e, { box: "border-box" });
        const pad = el("span", { className: "tag-pad", ariaHidden: "true" });
        pad.dataset["pad"] = m.id;
        padEls.set(m.id, pad);
        tags.prepend(pad);
      }
      e.classList.toggle("self", m.id === s.self);
      // Their shirt's colour on the tag's edge (OME-1375); a tint picked live changes it.
      const accent = tintAccent(TINTS, m.avatar, m.tint ?? 0) ?? "";
      if (e.style.getPropertyValue("--tint") !== accent) e.style.setProperty("--tint", accent);
      padEls.get(m.id)?.classList.toggle("self", m.id === s.self);
      // Away (OME-911): the tag is dimmed and says "Away" to screen readers; toggled only on a change.
      const isAway = m.away === true;
      if (e.classList.contains("is-away") !== isAway) {
        e.classList.toggle("is-away", isAway);
        if (isAway) e.append(el("span", { className: "sr-only tag-away", textContent: " (Away)" }));
        else e.querySelector(".tag-away")?.remove();
      }
    }
    restack();

    // The state says whose bubbles show (a speaker who left, or a reconnect, takes theirs along). Every line the floats
    // haven't had yet goes to them, oldest first, even when several landed since the last render (OME-809).
    speaking.clear();
    for (const b of s.bubbles) speaking.add(b.memberId);
    floats.keep(speaking);
    const me = s.self === null ? undefined : members.get(s.self);
    handoff.hand(s.bubbles, (b) => {
      const p = view.position(b.memberId) ?? placedAt.get(b.memberId);
      const m = members.get(b.memberId);
      if (p === undefined || m === undefined) return false;
      const accent = tintAccent(TINTS, m.avatar, m.tint ?? 0);
      floats.say({ id: b.memberId, name: m.nickname, text: b.text, ...(accent === null ? {} : { accent }), self: b.memberId === s.self, mention: b.memberId !== s.self && me !== undefined && mentions(b.text, me.nickname), at: { x: p.x, y: p.y - overOf(b.memberId) }, startedAt: b.expiresAt - BUBBLE_MS });
      return true;
    });

    renderSyslines(rail, s.syslines, syslineEls);
    applyCatching(s, selfCatching);
    // A look that changed (self, tint, away, catching) since the restack above: the canvas draws it.
    if (paintTags()) view.redraw();
  };

  return {
    root,
    overlay,
    tags,
    view,
    render,
    applyCatching,
    pair(thruster, bender) {
      if (!o.reducedMotion.matches) view.pair(thruster, bender);
    },
    emote(id, kind, s) {
      seated = s.room?.seats ?? seated;
      if (!o.reducedMotion.matches) {
        view.emote(id, kind);
        return;
      }
      const p = view.position(id) ?? placedAt.get(id);
      // The reach has no badge; room.ts never sends it under reduced motion.
      if (p !== undefined && kind !== "reach") badges.show(id, kind, { x: p.x, y: p.y - overOf(id) });
    },
    react(id, kind) {
      const p = view.position(id) ?? placedAt.get(id);
      return p === undefined ? 0 : glyphs.burst({ x: p.x, y: p.y - overOf(id) }, kind);
    },
    teleported(id) {
      teleporting.add(id);
    },
    typing: setTyping,
    stopTyping() {
      for (const id of typers) setTyping(id, false);
    },
    hide(id, hidden) {
      // Their typing-changed stops at intake from now on (OME-769): their dots go with it.
      if (hidden) setTyping(id, false);
      if (hidden) hiddenIds.add(id);
      else hiddenIds.delete(id);
      tagEls.get(id)?.classList.toggle("is-hidden", hidden);
      view.setDimmed(id, hidden);
      paintTags();
      view.redraw();
    },
    labelScale: (k) => {
      floats.scale(k);
      const tk = Math.min(k, TAG_MAX_SCALE);
      if (tk !== labelK) {
        labelK = tk;
        restack();
      }
    },
    bubbleAvoid: (boxes, w) => {
      over = { boxes, w };
      avoidOver();
    },
    bubbleSides: (x0, x1, y1, y0) => {
      floats.sides(x0, x1, y0);
      if (Number.isFinite(y0)) win = { x0, x1, y0 };
      avoidOver();
      if (y1 !== shownBottom || y0 !== shownTop) {
        shownBottom = y1;
        shownTop = y0;
        restack();
      }
    },
    seat: (i) => seats[i],
    anchor: (id) => view.position(id) ?? placedAt.get(id),
    tag: (id) => {
      const p = view.position(id) ?? placedAt.get(id);
      const m = tagAt.get(id) ?? aboveHead(id);
      return p === undefined ? undefined : { x: p.x + m.dx, y: p.y + TAG_OFFSET_Y + m.dy };
    },
    tagRects: () => {
      // Stage px to the viewport's CSS px: the canvas is the stage, CSS-scaled (and zoomed on a phone).
      const c = view.canvas.getBoundingClientRect();
      const k = c.width / STAGE_W;
      return [...tagEls].flatMap(([member, e]) => {
        const r = view.tags.rect(member);
        const led = (tagAt.get(member) ?? aboveHead(member)).led;
        return r === undefined ? [] : [{ member, text: e.querySelector(".tag-name")?.textContent ?? "", rect: { x: c.left + r.x * k, y: c.top + r.y * k, width: r.w * k, height: r.h * k }, led }];
      });
    },
    glyphRects: () => {
      const c = view.canvas.getBoundingClientRect();
      const k = c.width / STAGE_W;
      return glyphs.active().flatMap(({ kind, i }) => {
        const r = view.glyphs.rect(i);
        return r === undefined ? [] : [{ kind, rect: { x: c.left + r.x * k, y: c.top + r.y * k, width: r.w * k, height: r.h * k } }];
      });
    },
    cursorRect: () => {
      const cur = view.cursor();
      if (cur === null) return null;
      const c = view.canvas.getBoundingClientRect();
      const k = c.width / STAGE_W;
      return { kind: cur.kind, rect: { x: c.left + cur.rect.x * k, y: c.top + cur.rect.y * k, w: cur.rect.w * k, h: cur.rect.h * k } };
    },
    tagAnchor: (id) => anchors.get(id),
    hideTags: (hidden) => {
      view.tags.hide(hidden);
      view.redraw();
    },
    spot: (id) => placedAt.get(id),
    catCells: () => view.catCells(),
    petCat: (cell) => {
      view.petCat(cell);
    },
    cellOf(id) {
      const p = view.position(id) ?? placedAt.get(id);
      const c = p === undefined ? -1 : cellAt(p);
      return c < 0 ? null : { x: colOf(c), y: rowOf(c) };
    },
    head: (id) => {
      const p = view.position(id) ?? placedAt.get(id);
      return p === undefined ? undefined : { x: p.x, y: p.y - overOf(id) };
    },
    layoutBuilds: () => layoutBuilds,
  };
}
