// The room's stage: the Pixi room (floor, furniture, seats, avatars), the seat keys over it, the nickname tags, chat
// bubbles, emote badges and the system-line rail. Drawn from the room's state on the frames the caller asks for. Made
// once per page: the room tab's (room.ts), or, with the room popped out, the room window's (popout/room-pop.ts, OME-600),
// so the window draws exactly what the page would. The caller owns what clicks on a seat do.
import { SEAT_COUNT, layoutSeats, type EmoteKind, type FloorCell, type MemberId, type RoomLayout } from "@omega/shared";
import { createFloats } from "./bubbles/floats";
import { createHandoff } from "./bubbles/handoff";
import { el, renderSyslines } from "./controls/dom";
import { createEmoteBadges } from "./emote/badges";
import type { FurnitureAtlas } from "./furniture-atlas";
import { doorAt, layoutKey as keyOfLayout, layoutOf, piecesInUse, sceneOf, seatPoints, standDepth, standingPoints, usesSetG, usesV2, usesV4, usesV6 } from "./furniture";
import type { RoomAtlas } from "./room-atlas";
import type { RecolourSheets } from "./recolour-sheets";
import { recolourOf, recoloursIn, type RecolourSheet } from "./recolours";
import { doubleTap, isStepKey, seatViews, type StepKey } from "./intents";
import { SYSLINE_RAIL, TAG_OFFSET_Y, cellCenter, type Point, type Rect } from "./layout";
import { createRoomView, type AvatarPlacement, type RoomSound, type RoomView } from "./room-view";
import { BUBBLE_MS, catchingUp, type StageState } from "./state";
import { EMOTE_LIFT } from "./walk/animator";
import { cellAt, colOf, rowOf, walkGrid } from "./walk/path";
import { standingPlacement } from "./walk/standing";
import { awayChanges } from "./session-lifecycle";
import tintsJson from "../../../assets/avatars/tints.json";
import { AVATAR_IDS, parseTints, tintAccent } from "./walk/tint";
import type { Dir } from "./walk/walks";
import { onceAsync } from "./once";
import { mentions } from "./chat/mention";

/** The avatars' shirt ramps (tints.json), for the tag and bubble accents (OME-1375). */
const TINTS = parseTints(tintsJson, AVATAR_IDS);

export interface StageOptions {
  /** Under prefers-reduced-motion an emote is a static badge over the avatar instead of an animation (OME-415). */
  readonly reducedMotion: { readonly matches: boolean };
  /** Draw again on the next frame (the furniture atlas arrived). */
  readonly requestRender: () => void;
  /** The seats moved (a new layout): the phone's room window looks at their middle. */
  readonly onLayout?: (seats: readonly Point[]) => void;
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
  /** The seat keys' layer: one `[data-seat]` button per seat. */
  readonly overlay: HTMLElement;
  /** The nickname tags' layer (the owner's moderation tools hang their menu off a tag). */
  readonly tags: HTMLElement;
  readonly view: RoomView;
  /** Draw `s` with `layout` (the room's, or the owner's draft); `selfCatching` is my own player's catching-up flag; while
   * `editing`, the owner editor's hit layer has the floor, so the walk floor is inert. */
  render(s: StageState, layout: RoomLayout, selfCatching: boolean, editing: boolean): void;
  /** Only the catching-up hourglasses (my player's flag changes between renders). */
  applyCatching(s: StageState, selfCatching: boolean): void;
  emote(id: MemberId, kind: EmoteKind, s: StageState): void;
  /** Two members paired (OME-1672): the pose animation, unless reduced motion asks for stillness. */
  pair(thruster: MemberId, bender: MemberId): void;
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
  /** The floor cell a member is on now (mid-walk: the one they are crossing), or null if not drawn. */
  cellOf(id: MemberId): FloorCell | null;
  /** Bubbles are shown `k`× their size (the phone's zoomed-out room window, OME-1184). */
  labelScale(k: number): void;
  /** Where a member's emote shows (stage px): `anchor` lifted by EMOTE_LIFT. */
  head(id: MemberId): Point | undefined;
  /** How many times the furniture was rebuilt for a new layout. */
  layoutBuilds(): number;
}

/** A name tag's anchor: `translate`, so room.css's centring and readable-zoom scale stay in `transform` / `scale`. */
function place(e: HTMLElement, p: Point): void {
  e.style.translate = `${String(p.x)}px ${String(p.y)}px`;
}

/** How long the floor's cursor shows "can't go there" after a blocked click or step. */
const NO_GO_MS = 400;
/** How long the status note says it: longer, for screen readers that poll live regions late (OME-1364). */
const NO_GO_NOTE_MS = 1500;

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
    floats.typing(id, on, { x: p?.x ?? 0, y: (p?.y ?? 0) - liftOf(id) });
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
  // Tags, bubbles and emote badges ride along with a walking avatar; a bubble's tail tips just over the head.
  const view = await createRoomView({
    ...(o.roomId === undefined ? {} : { roomId: o.roomId }),
    ...(o.serverNow === undefined ? {} : { serverNow: o.serverNow }),
    ...(o.sound === undefined ? {} : { sound: o.sound }),
    onMove: (id, x, y) => {
      const head = y - liftOf(id);
      badges.move(id, x, head);
      floats.move(id, x, head);
      const tag = tagEls.get(id);
      if (tag !== undefined) place(tag, { x, y: y + TAG_OFFSET_Y });
      const pad = padEls.get(id);
      if (pad !== undefined) place(pad, { x, y: y + TAG_OFFSET_Y });
      o.onMove?.(id);
    },
    onStop: (id, x, y) => {
      floats.settle(id, x, y - liftOf(id));
      o.onStop?.(id);
    },
  });
  view.canvas.className = "scene";
  // The picture only: who is here and what they say is in the people list and the chat log (OME-1246).
  view.canvas.ariaHidden = "true";
  root.append(view.canvas, ...(o.dim === undefined ? [] : [o.dim]), ...(floorHit === null ? [] : [floorHit, floorNote]), overlay, tags, bubbles, rail);
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
    let hoverScale = 1;
    floorHit.addEventListener("pointermove", (ev) => {
      // A finger has no hover: a tap walks, a drag pans the phone's room window.
      if (ev.pointerType === "touch") return;
      const c = cellUnder(ev);
      // The scale too: after a zoom or resize the same cell's diamond gets its new stroke.
      const k = floorHit.getBoundingClientRect().width / Math.max(1, floorHit.offsetWidth);
      if (c?.x === hover?.x && c?.y === hover?.y && k === hoverScale) return;
      hover = c;
      hoverScale = k;
      view.marker(c, k);
    });
    floorHit.addEventListener("pointerleave", () => {
      if (hover === null) return;
      hover = null;
      view.marker(null, 1);
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
  /** The Dank Dungeon's atlas once loaded (OME-1672). */
  let v6Atlas: FurnitureAtlas | null = null;
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
  let drawnPlaying = false;
  /** The hourglass on each catching tag; a tag removed with its member takes its hourglass along. */
  const hourglasses = new Map<HTMLElement, HTMLElement>();

  const buildScene = (l: RoomLayout): void => {
    const catalogues = [atlas, v2Atlas, v4Atlas, v6Atlas].flatMap((a) => (a === null ? [] : [a.manifest]));
    scene = sceneOf(l, catalogues, roomAtlas?.manifest ?? null);
    view.setScene(scene, [atlas, v2Atlas, v4Atlas, v6Atlas, roomAtlas, recolours], grid);
    drawnSeats = undefined;
  };

  const sourceOf = (sheet: RecolourSheet): FurnitureAtlas | RoomAtlas | null =>
    sheet === "room/room.png" ? roomAtlas : sheet === "furniture/furniture.png" ? atlas : sheet === "furniture/furniture-v2.png" ? v2Atlas : v4Atlas;

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
    if (next.pairs === true) view.loadPairPoses();
    if (usesV4(next) && v4Atlas === null) {
      lazyAtlas("furniture v4", key, next, () => import("./furniture-v4-atlas").then((m) => m.loadFurnitureV4Atlas()), (a) => (v4Atlas = a));
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
      for (const v of views) {
        const p = seats[v.index];
        if (v.member !== null && p !== undefined) {
          placements.push({ id: v.member.id, avatar: v.member.avatar, tint: v.member.tint ?? 0, hair: v.member.hair ?? 0, accessory: v.member.accessory ?? 0, at: p, z: scene.seats[v.index]?.z ?? standDepth(p), seatFacing: seatFacings[v.index] ?? null });
          at.set(v.member.id, p);
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
        badges.move(id, p.x, p.y - liftOf(id));
        floats.move(id, p.x, p.y - liftOf(id));
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
      inUseStale = true;
    }
    const playing = s.room?.playback?.playing === true;
    if (inUseStale || playing !== drawnPlaying) {
      inUseStale = false;
      drawnPlaying = playing;
      view.setInUse(piecesInUse(nextLayout, standCells, playing, sitCells));
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
      b.ariaLabel = v.member === null ? `Seat ${String(v.index + 1)}, free` : v.isSelf ? `Seat ${String(v.index + 1)}, yours: stand up` : `Seat ${String(v.index + 1)}, taken by ${v.member.nickname}`;
    }

    // Nickname tags: exactly one per member, text only.
    const members = new Map((s.room?.members ?? []).map((m) => [m.id, m]));
    for (const [id, e] of tagEls) {
      if (members.has(id)) continue;
      e.remove();
      tagEls.delete(id);
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
      const p = view.position(m.id) ?? placedAt.get(m.id);
      if (p !== undefined) {
        place(e, { x: p.x, y: p.y + TAG_OFFSET_Y });
        const pad = padEls.get(m.id);
        if (pad !== undefined) place(pad, { x: p.x, y: p.y + TAG_OFFSET_Y });
      }
    }

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
      floats.say({ id: b.memberId, name: m.nickname, text: b.text, ...(accent === null ? {} : { accent }), self: b.memberId === s.self, mention: b.memberId !== s.self && me !== undefined && mentions(b.text, me.nickname), at: { x: p.x, y: p.y - liftOf(b.memberId) }, startedAt: b.expiresAt - BUBBLE_MS });
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
      if (p !== undefined) badges.show(id, kind, { x: p.x, y: p.y - liftOf(id) });
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
    },
    labelScale: (k) => {
      floats.scale(k);
    },
    seat: (i) => seats[i],
    anchor: (id) => view.position(id) ?? placedAt.get(id),
    cellOf(id) {
      const p = view.position(id) ?? placedAt.get(id);
      const c = p === undefined ? -1 : cellAt(p);
      return c < 0 ? null : { x: colOf(c), y: rowOf(c) };
    },
    head: (id) => {
      const p = view.position(id) ?? placedAt.get(id);
      return p === undefined ? undefined : { x: p.x, y: p.y - liftOf(id) };
    },
    layoutBuilds: () => layoutBuilds,
  };
}
