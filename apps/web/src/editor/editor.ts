// The owner's layout editor (OME-410, ADR 0028; art: set (h), assets/README.md). A lazy chunk: room.ts imports it only when
// the owner presses "Edit room", so guests never load it or its edit kit. The owner edits a local draft (the room shows it to
// them alone) and sends one `layout-set` on Save, only once the draft is a valid layout. Rename sends `title-set`; delete is
// `DELETE /rooms/:id` with the owner token, after a confirm step. Every string goes in as text.
import * as v from "valibot";
import { Container, Graphics, Sprite } from "pixi.js";
import { drawCursor } from "../cell-cursor";
import {
  DeleteRoomResponseSchema,
  FLOOR_CELLS,
  FURNITURE,
  MAX_DOORS,
  MAX_FURNITURE,
  ROOM_TITLE_MAX_LENGTH,
  RoomIdSchema,
  RoomTitleSchema,
  type ClientMessage,
  type DeleteRoomErrorCode,
  type Furniture,
  type FurnitureKind,
  type OwnerToken,
  type RoomId,
  type RoomLayout,
} from "@omega/shared";
import { el } from "../controls/dom";
import { atlasId, coloursOf } from "./colours";
import { cellCenter } from "../layout";
import { loadRoomSecrets } from "../room-secrets";
import { TRAY_TABS, defaultFacing, wallKeys, doorCount, needsSecondPad, padCount, parseDoorTarget, type TrayTab, fits, reconcile, pieceAt, place, problemText, problems, remove, rotate, sameLayout } from "./draft";
import { loadEditAtlas, type EditAtlas } from "./edit-atlas";
import { createMoodPicker } from "./mood";
import v8Url from "../../../../assets/furniture/furniture-v8.png?url";
import { V8_THUMBS, trayScale } from "./v8-thumbs";
import { markerKeys, slotAt, step, type CursorKey, type MarkerState, type Slot } from "./pick";
import { SAVED_LAYOUT_NAME_MAX, saveLayout, saveMessage, type LayoutStore } from "../saved-layouts";

export interface EditorContext {
  /** Where the tray and the room's settings go (under the stage). */
  readonly panel: HTMLElement;
  /** The scaled 960×600 stage: the editor lays its click layer over it. */
  readonly stage: HTMLElement;
  /** room-view.ts: the layer for the grid and markers, and a one-off redraw. */
  readonly view: { readonly editLayer: Container; redraw(): void };
  /** The room's saved layout and title, as the server last said. */
  readonly saved: () => RoomLayout;
  readonly title: () => string | null;
  /** Show the owner this layout instead of the saved one (null: the saved one again). */
  readonly preview: (layout: RoomLayout | null) => void;
  readonly send: (msg: ClientMessage) => boolean;
  readonly roomId: RoomId;
  readonly serverUrl: string;
  readonly ownerToken: OwnerToken;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** False once this editor was closed; checked after the edit kit loads, before anything is mounted. */
  readonly alive: () => boolean;
}

export interface Editor {
  /** The room's layout or title changed (a save landed, or another tab of the owner's saved). */
  update(): void;
  /**
   * Done or Escape (OME-2074): close at once when nothing is unsaved; otherwise ask Save / Discard / Keep editing, and
   * call `close` after Save or Discard. Asked again while the prompt shows, it keeps editing.
   */
  leave(close: () => void): void;
  destroy(): void;
}

/** The tray thumbnail of a piece with no colours (ui/edit.png, OME-1847): the rest fall back to their name. */
const TRAY_ONLY_COLOUR: Readonly<Partial<Record<FurnitureKind, string>>> = { armchair: "velvet", tv: "charcoal" };

const NAMES: Readonly<Record<FurnitureKind, string>> = {
  armchair: "Armchair",
  tv: "TV console",
  lamp: "Lamp",
  plant: "Plant",
  rug: "Big rug",
  sofa: "Sofa",
  couch: "Couch",
  wingback: "Wingback chair",
  beanbag: "Beanbag",
  sidetable: "Side table",
  arclamp: "Arc lamp",
  monstera: "Monstera",
  popcorn: "Popcorn cart",
  bookshelf: "Bookcase",
  runner: "Kilim runner",
  frame: "Print",
  floorcushion: "Floor cushions",
  bench: "Storage bench",
  turntable: "Record console",
  speaker: "Floor speaker",
  cat: "Sleepy cat",
  wallshelf: "Wall shelf",
  garland: "String lights",
  coffeetable: "Coffee table",
  pouf: "Pouf",
  neonsign: "Neon sign",
  aquarium: "Aquarium",
  arcade: "Arcade cabinet",
  wallclock: "Wall clock",
  door: "Door",
  hammock: "Hammock",
  stool: "Bar stool",
  barcounter: "Bar counter",
  piano: "Upright piano",
  fireplace: "Fireplace",
  pad: "Teleport pads (pair)",
  theatrerow: "Theatre row",
  curtain: "Curtain",
  bigscreen: "Big screen",
  aislelight: "Aisle light",
  carpet: "Theatre carpet",
  bed: "Queen bed",
  whirlpool: "Whirlpool",
  mirror: "Wall mirror",
  minibar: "Minibar",
  desk: "Writing desk",
  washbasin: "Washbasin",
  partition: "Interior wall",
  sauna: "Sauna",
  soaktub: "Soaking tub",
  lounger: "Lounger",
  wallscreen: "Wall screen",
  projector: "Projector screen",
  tripod: "Projector on a tripod",
  window: "Window",
  longclock: "Long-case clock",
  lavalamp: "Lava lamp",
};

const DELETED = "Room deleted.";
const DELETE_ERRORS: Readonly<Record<DeleteRoomErrorCode, string>> = {
  room_not_found: "This room is already gone.",
  unauthorized: "This browser doesn't hold the room's owner key any more.",
  rate_limited: "Too many tries. Wait a moment and try again.",
  unavailable: "The server couldn't delete the room. Try again later.",
};

const sprite = (name: string): HTMLSpanElement => el("span", { className: `ui-sprite ${name}`, ariaHidden: "true" });
/** A piece's se frame cut from furniture-v8.png (the sheet is 512 px wide), at 1/n of the kit's pixel size (OME-2095). */
function v8Thumb(r: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): HTMLSpanElement {
  const n = trayScale(r);
  const px = (v: number): string => `calc(${String(v / n)} * var(--ui-px, 2px))`;
  const b = el("span", { className: "ui-sprite", ariaHidden: "true" });
  b.style.cssText = `display:block;width:${px(r.w)};height:${px(r.h)};background:url(${v8Url}) ${px(-r.x)} ${px(-r.y)}/${px(512)} auto;image-rendering:pixelated`;
  return b;
}

/** The piece in hand: its kind, colour, and for a door the room it leads to (asked for first, OME-1425). */
interface Held {
  readonly kind: FurnitureKind;
  readonly variant: number;
  readonly target?: RoomId;
}

/** The piece a click would put down: the held kind at the slot, facing the wall it hangs on or its default way. */
function candidate({ kind, variant, target }: Held, slot: Slot): Furniture | null {
  const onWall = FURNITURE[kind].layer === "wall";
  if (onWall !== (slot.wall !== null)) return null;
  const facing = slot.wall ?? defaultFacing(kind, slot.col, slot.row);
  const piece: Furniture = { kind, col: slot.col, row: slot.row, facing };
  return { ...piece, ...(variant === 0 ? {} : { variant }), ...(target === undefined ? {} : { target }) };
}

/** The placed piece at a slot: on the floor, an object over a rug; on a wall, the print in that slot. */
function indexAt(layout: RoomLayout, slot: Slot): number | null {
  if (slot.wall === null) return pieceAt(layout, slot.col, slot.row);
  // A screen is on every segment it covers, not only its anchor.
  const here = `${slot.wall === "sw" ? "r" : "l"}${String(slot.wall === "sw" ? slot.col : slot.row)}`;
  const i = layout.furniture.findIndex((f) => FURNITURE[f.kind].layer === "wall" && f.facing === slot.wall && wallKeys(f).includes(here));
  return i < 0 ? null : i;
}

/** The selected piece moved to `slot` (a print takes the facing of the wall it moves to), or null if it can't go there. */
function moved(layout: RoomLayout, index: number, slot: Slot): RoomLayout | null {
  const f = layout.furniture[index];
  if (f === undefined) return null;
  const onWall = FURNITURE[f.kind].layer === "wall";
  if (onWall !== (slot.wall !== null)) return null;
  const next: Furniture = { ...f, col: slot.col, row: slot.row, facing: slot.wall ?? f.facing };
  if (!fits(layout, next, index)) return null;
  return { ...layout, furniture: layout.furniture.map((p, i) => (i === index ? next : p)) };
}

const CURSOR_KEYS: ReadonlySet<string> = new Set<CursorKey>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const isCursorKey = (key: string): key is CursorKey => CURSOR_KEYS.has(key);
/** "column 3 row 5", or "right wall 3" (a print's slot along the back-right wall, sw) / "left wall 3" (se). */
const placeOf = (s: Slot): string =>
  s.wall === null ? `column ${String(s.col + 1)} row ${String(s.row + 1)}` : s.wall === "sw" ? `right wall ${String(s.col + 1)}` : `left wall ${String(s.row + 1)}`;

export async function mountEditor(ctx: EditorContext): Promise<Editor> {
  const atlas: EditAtlas = await loadEditAtlas();
  // Closed (or closed and reopened) while the kit loaded: touch nothing a newer editor may own.
  if (!ctx.alive()) return { update: () => undefined, leave: (close) => {
    close();
  }, destroy: () => undefined };

  let saved = ctx.saved();
  let draft = saved;
  let held: Held | null = null;
  let selected: number | null = null;
  let hover: Slot | null = null;
  /** The keyboard cursor (OME-1245): shown while the room has keyboard focus, redrawn only on key input. */
  let cursor: Slot = { col: 0, row: 0, wall: null };
  let tab: TrayTab["id"] = "seats";
  /** A `layout-set` went out and its `layout-changed` hasn't come back. */
  let saving = false;

  // ---- Room layer: the grid once, markers per change (set (h) order: floor → rugs → grid → markers → objects).
  const grid = new Container({ label: "edit-grid" });
  const gridTexture = atlas.texture("edit/grid");
  if (gridTexture !== undefined) {
    for (let c = 0; c < FLOOR_CELLS; c++) {
      for (let r = 0; r < FLOOR_CELLS; r++) {
        const p = cellCenter(c, r);
        grid.addChild(new Sprite({ texture: gridTexture, x: p.x, y: p.y }));
      }
    }
  }
  const markers = new Container({ label: "edit-markers" });
  const cursorMark = new Graphics({ label: "edit-cursor", visible: false });
  ctx.view.editLayer.addChild(grid, markers, cursorMark);

  const addMarkers = (f: Pick<Furniture, "kind" | "col" | "row" | "facing">, state: MarkerState): void => {
    for (const m of markerKeys(f, state)) {
      const texture = atlas.texture(m.key);
      if (texture === undefined) continue;
      const p = cellCenter(m.col, m.row);
      markers.addChild(new Sprite({ texture, x: p.x, y: p.y }));
    }
  };
  const drawMarkers = (): void => {
    for (const m of markers.removeChildren()) m.destroy();
    const sel = selected === null ? undefined : draft.furniture[selected];
    if (sel !== undefined) addMarkers(sel, "sel");
    if (hover !== null) {
      if (held !== null) {
        const c = candidate(held, hover);
        if (c !== null) addMarkers(c, fits(draft, c) ? "ok" : "no");
      } else if (selected !== null && sel !== undefined && indexAt(draft, hover) === null) {
        const next = moved(draft, selected, hover);
        addMarkers({ ...sel, col: hover.col, row: hover.row, facing: hover.wall ?? sel.facing }, next === null ? "no" : "ok");
      }
    }
    ctx.view.redraw();
  };

  // ---- Click layer over the stage, and the keyboard's way in: arrows walk a cell cursor, Enter (or Space) acts like a click there.
  const hit = el(
    "div",
    { className: "editor-hit", tabIndex: 0, role: "application", ariaLabel: "Room floor. Arrow keys move the cursor, Enter places, picks or moves a piece." },
    "editor-hit",
  );
  const slotOf = (ev: MouseEvent): Slot | null => {
    const r = hit.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return slotAt(((ev.clientX - r.left) * hit.offsetWidth) / r.width, ((ev.clientY - r.top) * hit.offsetHeight) / r.height);
  };
  hit.addEventListener("pointermove", (ev) => {
    const s = slotOf(ev);
    if (s?.col === hover?.col && s?.row === hover?.row && s?.wall === hover?.wall) return;
    hover = s;
    drawMarkers();
  });
  hit.addEventListener("pointerleave", () => {
    hover = null;
    drawMarkers();
  });
  hit.addEventListener("click", (ev) => {
    const s = slotOf(ev);
    if (s !== null) act(s);
  });
  hit.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (isCursorKey(ev.key)) cursor = step(cursor, ev.key);
    else if (ev.key === "Enter" || ev.key === " ") act(cursor);
    else return;
    // Taken here, so the room's Enter-to-chat and the page's scroll don't also run.
    ev.preventDefault();
    showCursor();
  });
  // Only a keyboard focus shows the cursor: a click focuses the layer too, and the pointer has its own markers.
  hit.addEventListener("focus", () => {
    if (hit.matches(":focus-visible")) showCursor();
  });
  hit.addEventListener("blur", () => {
    if (!cursorMark.visible) return;
    cursorMark.visible = false;
    hover = null;
    drawMarkers();
  });
  function showCursor(): void {
    hover = cursor;
    // Screen px per stage px, read once per key press (the stage is CSS-scaled, small in the editor).
    const r = hit.getBoundingClientRect();
    drawCursor(cursorMark, cursor, hit.offsetWidth > 0 ? r.width / hit.offsetWidth : 1);
    cursorMark.visible = true;
    cursorText.textContent = describeCursor();
    drawMarkers();
  }
  /** What the cursor is on, for the live line: "Sofa, column 3 row 5". */
  function describeCursor(): string {
    const at = indexAt(draft, cursor);
    const piece = at === null ? undefined : draft.furniture[at];
    const sel = selected === null ? undefined : draft.furniture[selected];
    const where = placeOf(cursor);
    if (held !== null) {
      const c = candidate(held, cursor);
      return `${NAMES[held.kind]}, ${where}${c !== null && fits(draft, c) ? "" : ", can't go here"}`;
    }
    if (piece !== undefined) return `${NAMES[piece.kind]}, ${where}`;
    const empty = `${cursor.wall === null ? "Empty floor" : "Empty wall"}, ${where}`;
    if (sel === undefined || selected === null) return empty;
    const name = NAMES[sel.kind].toLowerCase();
    return moved(draft, selected, cursor) === null ? `${empty}: the ${name} can't go here` : `${empty}: Enter moves the ${name} here`;
  }
  function act(s: Slot): void {
    say("");
    if (held !== null) {
      const c = candidate(held, s);
      const next = c === null ? null : place(draft, c);
      if (next === null) {
        say(c === null ? `The ${NAMES[held.kind].toLowerCase()} can't go there.` : "That spot is taken or off the floor.");
        return;
      }
      // A pad comes as a pair (OME-1548): the same pad stays in hand for the second.
      const second = held.kind === "pad" && needsSecondPad(next);
      held = second ? held : null;
      setDraft(next, second ? null : next.furniture.length - 1);
      return;
    }
    const at = indexAt(draft, s);
    if (at !== null || selected === null) {
      selected = at;
      refresh();
      return;
    }
    const next = moved(draft, selected, s);
    if (next === null) {
      say("It can't go there.");
      return;
    }
    setDraft(next, selected);
  }
  ctx.stage.append(hit);

  // ---- Tray: tabs, cubbies, the picked piece's name, colours and actions, the count, Save.
  const root = el("section", { className: "editor", ariaLabel: "Edit room" }, "editor");
  const tabs = el("div", { className: "ui-tabs", role: "tablist" });
  const tray = el("div", { className: "ui-tray", role: "tabpanel" }, "editor-tray");
  const tabButtons = TRAY_TABS.map((t) => {
    const b = el("button", { type: "button", className: "ui-tab", role: "tab" }, "editor-tab");
    b.append(sprite(`ui-glyph-tab-${t.id}`), t.label);
    b.addEventListener("click", () => {
      tab = t.id;
      refresh();
    });
    return b;
  });
  tabs.append(...tabButtons);
  const slots = new Map<FurnitureKind, HTMLButtonElement>();
  for (const t of TRAY_TABS) {
    for (const kind of t.kinds) {
      const b = el("button", { type: "button", className: "ui-slot", title: NAMES[kind], ariaLabel: NAMES[kind] }, "editor-slot");
      b.dataset["kind"] = kind;
      const colour = coloursOf(kind)[0] ?? TRAY_ONLY_COLOUR[kind];
      const v8 = V8_THUMBS[kind];
      b.append(v8 !== undefined ? v8Thumb(v8) : colour === undefined ? el("span", { className: "editor-slot-name", textContent: NAMES[kind] }) : sprite(`ui-thumb-${atlasId(kind) ?? kind}-${colour}`));
      b.addEventListener("click", (ev) => {
        if (b.ariaDisabled === "true") return;
        selected = null;
        if (kind === "door" && held?.kind !== "door") {
          // A door asks where it leads before it can be placed.
          held = null;
          openPicker();
          return;
        }
        picking = false;
        held = held?.kind === kind ? null : { kind, variant: 0 };
        refresh();
        // Picked with the keyboard (no pointer, so detail 0): the room takes focus, with the cursor where it last was.
        if (held !== null && ev.detail === 0) hit.focus({ preventScroll: true });
      });
      slots.set(kind, b);
    }
  }
  tray.append(...slots.values());
  const doorsLine = el("p", { className: "editor-count" }, "editor-doors");

  // ---- The door's room (OME-1425): one of this browser's saved rooms, or a pasted link of this site.
  let picking = false;
  const picker = el("div", { className: "editor-door-picker", hidden: true }, "door-picker");
  const pickerRooms = el("ul", { className: "editor-door-rooms" });
  const pickerInput = el("input", { type: "text", id: "editor-door-link", className: "ui-input", maxLength: 300, autocomplete: "off", placeholder: "https://…/r/room" }, "door-target-input");
  const pickerUse = el("button", { type: "button", className: "ui-button", textContent: "Use link" }, "door-target-use");
  const pickerCancel = el("button", { type: "button", className: "ui-button secondary", textContent: "Cancel" });
  const pickerError = el("p", { className: "editor-message", role: "alert" }, "door-target-error");
  picker.append(
    el("p", { textContent: "Where does the door lead?" }),
    pickerRooms,
    el("label", { htmlFor: pickerInput.id, textContent: "Or paste a room link" }),
    pickerInput,
    pickerUse,
    pickerCancel,
    pickerError,
  );
  /** Rooms this browser saved (titles as text), this room left out; localStorage is untrusted, so ids are checked. */
  const savedRooms = (): { id: RoomId; label: string }[] => {
    try {
      return Object.entries(loadRoomSecrets(localStorage).rooms).flatMap(([id, s]) => (id !== ctx.roomId && v.safeParse(RoomIdSchema, id).success ? [{ id, label: s.title ?? id }] : []));
    } catch {
      return [];
    }
  };
  const chooseTarget = (target: RoomId): void => {
    picking = false;
    held = { kind: "door", variant: 0, target };
    pickerInput.value = "";
    pickerError.textContent = "";
    refresh();
    hit.focus({ preventScroll: true });
  };
  function openPicker(): void {
    picking = true;
    pickerError.textContent = "";
    pickerRooms.replaceChildren(
      ...savedRooms().map((r) => {
        const b = el("button", { type: "button", className: "ui-button secondary", textContent: r.label }, "door-target-room");
        b.addEventListener("click", () => {
          chooseTarget(r.id);
        });
        const li = el("li");
        li.append(b);
        return li;
      }),
    );
    refresh();
    pickerInput.focus({ preventScroll: true });
  }
  const useLink = (): void => {
    const r = parseDoorTarget(pickerInput.value, location.origin, ctx.roomId);
    if (r.ok) chooseTarget(r.id);
    else pickerError.textContent = r.error;
  };
  pickerUse.addEventListener("click", useLink);
  pickerInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    useLink();
  });
  pickerCancel.addEventListener("click", () => {
    picking = false;
    refresh();
  });

  const pickedName = el("p", { className: "editor-picked" }, "editor-picked");
  const swatches = el("div", { className: "ui-swatches", role: "radiogroup", ariaLabel: "Colour" });
  const rotateBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Turn" }, "editor-rotate");
  const removeBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Put back" }, "editor-remove");
  const count = el("p", { className: "editor-count" }, "editor-count");
  const cursorText = el("p", { className: "editor-cursor", ariaLive: "polite" }, "editor-cursor");
  const problemList = el("ul", { className: "editor-problems", ariaLive: "polite" }, "editor-problems");
  const message = el("p", { className: "editor-message", role: "status" }, "editor-message");
  const saveBtn = el("button", { type: "button", className: "ui-button", textContent: "Save layout" }, "editor-save");
  const resetBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Undo changes" }, "editor-reset");
  rotateBtn.addEventListener("click", () => {
    if (selected === null) return;
    const next = rotate(draft, selected);
    if (next === null) say("It can't turn there.");
    else setDraft(next, selected);
  });
  removeBtn.addEventListener("click", (ev) => {
    if (selected === null) return;
    setDraft(remove(draft, selected), null);
    // The button turns off under the keyboard's focus: hand it to the room rather than lose it to the page.
    if (ev.detail === 0) hit.focus({ preventScroll: true });
  });
  saveBtn.addEventListener("click", () => {
    if (problems(draft).length > 0 || sameLayout(draft, saved)) return;
    saving = ctx.send({ type: "layout-set", layout: draft });
    if (saving) say("Saving…");
    else say("Not connected. Try again in a moment.");
  });
  resetBtn.addEventListener("click", () => {
    setDraft(saved, null);
  });
  // "Save as my layout" (OME-910): keeps the room's *saved* layout (the last one the server confirmed, never an unsaved or
  // invalid draft) in this browser, to start a later room from. The name starts as the room's title.
  const mineName = el("input", { type: "text", id: "editor-mine-name", className: "ui-input", maxLength: SAVED_LAYOUT_NAME_MAX, autocomplete: "off", value: ctx.title() ?? "" }, "editor-mine-name");
  const mineLabel = el("label", { htmlFor: mineName.id, textContent: "Layout name" });
  const mineBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Save as my layout" }, "editor-mine-save");
  mineBtn.addEventListener("click", () => {
    let store: LayoutStore | null = null;
    try {
      store = localStorage;
    } catch {
      store = null;
    }
    say(store === null ? saveMessage(mineName.value, { ok: false, reason: "storage" }) : saveMessage(mineName.value, saveLayout(store, mineName.value, saved)));
  });
  const minePanel = el("div", { className: "editor-mine" });
  minePanel.append(mineLabel, mineName, mineBtn);
  const mood = createMoodPicker((m) => {
    setDraft({ ...draft, mood: m }, selected);
  });
  const piecePanel = el("div", { className: "editor-piece" });
  piecePanel.append(pickedName, swatches, rotateBtn, removeBtn, cursorText);
  const savePanel = el("div", { className: "editor-save-row" });
  savePanel.append(count, saveBtn, resetBtn, message);

  // ---- Leaving with unsaved changes (OME-2074): Done asks instead of dropping the draft.
  const leavePrompt = el("div", { className: "editor-confirm", hidden: true }, "editor-leave");
  const leaveSave = el("button", { type: "button", className: "ui-button", textContent: "Save" }, "editor-leave-save");
  const leaveDiscard = el("button", { type: "button", className: "ui-button secondary", textContent: "Discard" }, "editor-leave-discard");
  const leaveKeep = el("button", { type: "button", className: "ui-button secondary", textContent: "Keep editing" }, "editor-leave-keep");
  leavePrompt.append(el("p", { textContent: "Save your changes to the room?" }), leaveSave, leaveDiscard, leaveKeep);
  let closeAfter: (() => void) | null = null;
  const keepEditing = (): void => {
    closeAfter = null;
    // Its buttons are going: hand the keyboard's focus to the room rather than lose it to the page.
    if (leavePrompt.contains(document.activeElement)) hit.focus({ preventScroll: true });
    leavePrompt.hidden = true;
  };
  leaveSave.addEventListener("click", () => {
    const close = closeAfter;
    saveBtn.click();
    // Not sent (offline or a problem): stay, with the reason in the message line.
    if (saving && close !== null) close();
    else keepEditing();
  });
  leaveDiscard.addEventListener("click", () => {
    closeAfter?.();
  });
  leaveKeep.addEventListener("click", keepEditing);

  // ---- The room itself: rename and delete.
  const settings = el("div", { className: "editor-settings" });
  const titleInput = el("input", { type: "text", id: "editor-title", className: "ui-input", maxLength: ROOM_TITLE_MAX_LENGTH, autocomplete: "off", value: ctx.title() ?? "" }, "editor-title");
  const titleLabel = el("label", { htmlFor: titleInput.id, textContent: "Room name" });
  const renameBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Rename" }, "editor-rename");
  const deleteBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Delete room" }, "editor-delete");
  const confirm = el("div", { className: "editor-confirm", hidden: true });
  const confirmBtn = el("button", { type: "button", className: "ui-button", textContent: "Yes, delete it" }, "editor-delete-confirm");
  const keepBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Keep it" });
  confirm.append(el("p", { textContent: "Delete this room for everyone? This can't be undone." }), confirmBtn, keepBtn);
  const roomMessage = el("p", { className: "editor-message", role: "status" }, "editor-room-message");
  settings.append(titleLabel, titleInput, renameBtn, deleteBtn, confirm, roomMessage);
  renameBtn.addEventListener("click", () => {
    const parsed = v.safeParse(RoomTitleSchema, titleInput.value);
    if (!parsed.success) {
      titleInput.ariaInvalid = "true";
      roomMessage.textContent = "That name can't be used. Letters, digits, spaces and simple punctuation only.";
      return;
    }
    titleInput.ariaInvalid = "false";
    // The server answers an unchanged title with nothing, so there'd be no title-changed to settle "Renaming…".
    if (parsed.output === ctx.title()) {
      roomMessage.textContent = "Renamed.";
      return;
    }
    roomMessage.textContent = ctx.send({ type: "title-set", title: parsed.output }) ? "Renaming…" : "Not connected. Try again in a moment.";
  });
  deleteBtn.addEventListener("click", () => {
    confirm.hidden = false;
    deleteBtn.hidden = true;
    confirmBtn.focus();
  });
  keepBtn.addEventListener("click", () => {
    confirm.hidden = true;
    deleteBtn.hidden = false;
    deleteBtn.focus();
  });
  confirmBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    roomMessage.textContent = "Deleting…";
    // On success the server closes everyone's socket with 4004, and room.ts shows the closed card.
    void deleteRoom().then((text) => {
      // Deleted: the closed card replaces the view, so the button stays off rather than flash back on.
      confirmBtn.disabled = text === DELETED;
      roomMessage.textContent = text;
    });
  });
  const deleteRoom = async (): Promise<string> => {
    try {
      const res = await ctx.fetch(`${ctx.serverUrl}/rooms/${ctx.roomId}`, { method: "DELETE", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
      const parsed = v.safeParse(DeleteRoomResponseSchema, await res.json());
      if (!parsed.success) return DELETE_ERRORS.unavailable;
      return parsed.output.ok ? DELETED : DELETE_ERRORS[parsed.output.error.code];
    } catch {
      return "Couldn't reach the server. Try again.";
    }
  };

  root.append(leavePrompt, tabs, tray, doorsLine, picker, piecePanel, mood.el, problemList, savePanel, minePanel, settings);
  ctx.panel.replaceChildren(root);

  function say(text: string): void {
    message.textContent = text;
  }

  function setDraft(next: RoomLayout, select: number | null): void {
    draft = next;
    selected = select;
    ctx.preview(sameLayout(draft, saved) ? null : draft);
    refresh();
  }

  function refresh(): void {
    const kinds = TRAY_TABS.find((t) => t.id === tab)?.kinds ?? [];
    tabButtons.forEach((b, i) => {
      b.ariaSelected = String(TRAY_TABS[i]?.id === tab);
    });
    const full = draft.furniture.length >= MAX_FURNITURE;
    const doors = doorCount(draft);
    for (const [kind, b] of slots) {
      b.hidden = !kinds.includes(kind);
      b.ariaPressed = String(held?.kind === kind);
      const capped = kind === "door" && doors >= MAX_DOORS;
      b.ariaDisabled = String(full || capped || (kind === "pad" && padCount(draft) >= 2));
      b.title = capped ? `A room has at most ${String(MAX_DOORS)} doors` : NAMES[kind];
    }
    doorsLine.textContent = `Doors ${String(doors)}/${String(MAX_DOORS)}`;
    picker.hidden = !picking;
    const piece = selected === null ? undefined : draft.furniture[selected];
    const kind = held?.kind ?? piece?.kind;
    const variant = held?.variant ?? piece?.variant ?? 0;
    pickedName.textContent =
      picking
        ? "Door: pick where it leads, then place it"
        : held?.kind === "pad" && needsSecondPad(draft)
        ? "Place the second teleport pad"
        : held !== null
        ? `${NAMES[held.kind]}: click the room, or use the arrow keys and Enter there, to place it`
        : piece !== undefined
          ? `${NAMES[piece.kind]}: arrow keys and Enter in the room move it`
          : "Pick a piece in the room or the tray (in the room: arrow keys, then Enter)";
    rotateBtn.disabled = piece === undefined;
    removeBtn.disabled = piece === undefined;
    const colours = kind === undefined ? [] : coloursOf(kind);
    swatches.replaceChildren(
      ...(colours.length < 2
        ? []
        : colours.map((c, i) => {
            const b = el("button", { type: "button", className: "ui-swatch", role: "radio", ariaLabel: c, ariaChecked: String(i === variant) }, "editor-swatch");
            b.append(sprite(`ui-swatch-${c}`), sprite("ui-swatch-ring"));
            b.addEventListener("click", () => {
              if (held !== null) {
                held = { ...held, variant: i };
                refresh();
              } else if (selected !== null && piece !== undefined) {
                const recoloured: Furniture = { ...piece, variant: i };
                setDraft({ ...draft, furniture: draft.furniture.map((p, j) => (j === selected ? recoloured : p)) }, selected);
              }
            });
            return b;
          })),
    );
    const found = problems(draft);
    problemList.replaceChildren(...found.map((p) => el("li", { textContent: problemText(p) })));
    count.textContent = `${String(draft.furniture.length)} / ${String(MAX_FURNITURE)} pieces`;
    mood.set(draft.mood ?? "none");
    const dirty = !sameLayout(draft, saved);
    saveBtn.disabled = !dirty || found.length > 0;
    leaveSave.disabled = saveBtn.disabled;
    resetBtn.disabled = !dirty;
    hit.classList.toggle("holding", held !== null);
    drawMarkers();
  }

  refresh();

  return {
    update() {
      const next = ctx.saved();
      if (next !== saved) {
        const r = reconcile({ saved, draft, next, saving });
        saved = next;
        if (r.outcome === "saved") {
          saving = false;
          say("Saved.");
        } else if (r.outcome === "conflict") say("The room was changed somewhere else. Save puts your version back.");
        // Same content (a re-join snapshot) or our own save: the selection still points at the same piece.
        setDraft(r.draft, r.outcome === "replaced" ? null : selected);
      }
      const title = ctx.title();
      if (title !== null && document.activeElement !== titleInput && titleInput.value !== title) titleInput.value = title;
      if (title !== null && roomMessage.textContent === "Renaming…" && titleInput.value === title) roomMessage.textContent = "Renamed.";
    },
    leave(close) {
      if (!leavePrompt.hidden) keepEditing();
      else if (sameLayout(draft, saved)) close();
      else {
        closeAfter = close;
        leavePrompt.hidden = false;
        leaveKeep.focus();
      }
    },
    destroy() {
      ctx.preview(null);
      hit.remove();
      root.remove();
      ctx.view.editLayer.removeChild(grid, markers, cursorMark);
      grid.destroy({ children: true });
      markers.destroy({ children: true });
      cursorMark.destroy();
      ctx.view.redraw();
    },
  };
}
