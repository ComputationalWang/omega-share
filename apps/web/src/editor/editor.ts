// The owner's layout editor (OME-410, ADR 0028; art: set (h), assets/README.md). A lazy chunk: room.ts imports it only when
// the owner presses "Edit room", so guests never load it or its edit kit. The owner edits a local draft (the room shows it to
// them alone) and sends one `layout-set` on Save, only once the draft is a valid layout. Rename sends `title-set`; delete is
// `DELETE /rooms/:id` with the owner token, after a confirm step. Every string goes in as text.
import * as v from "valibot";
import { Container, Sprite } from "pixi.js";
import {
  DeleteRoomResponseSchema,
  FLOOR_CELLS,
  FURNITURE,
  MAX_FURNITURE,
  ROOM_TITLE_MAX_LENGTH,
  RoomTitleSchema,
  type ClientMessage,
  type DeleteRoomErrorCode,
  type Furniture,
  type FurnitureKind,
  type OwnerToken,
  type RoomId,
  type RoomLayout,
} from "@omega/shared";
import furnitureJson from "../../../../assets/furniture/furniture.json";
import { el } from "../controls/dom";
import { FurnitureManifestSchema } from "../furniture";
import { cellCenter } from "../layout";
import { TRAY_TABS, defaultFacing, type TrayTab, fits, pieceAt, place, problemText, problems, remove, rotate } from "./draft";
import { loadEditAtlas, type EditAtlas } from "./edit-atlas";
import { markerKeys, slotAt, type MarkerState, type Slot } from "./pick";

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
}

export interface Editor {
  /** The room's layout or title changed (a save landed, or another tab of the owner's saved). */
  update(): void;
  destroy(): void;
}

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
};

const DELETE_ERRORS: Readonly<Record<DeleteRoomErrorCode, string>> = {
  room_not_found: "This room is already gone.",
  unauthorized: "This browser doesn't hold the room's owner key any more.",
  rate_limited: "Too many tries. Wait a moment and try again.",
  unavailable: "The server couldn't delete the room. Try again later.",
};

/** Set (g) colour names per catalogue piece (the kilim runner is atlas id `rug`); the room atlas pieces have none. */
const COLOURS: ReadonlyMap<string, readonly string[]> = new Map(
  v.parse(FurnitureManifestSchema, furnitureJson).meta.omega.pieces.map((p) => [p.id, p.colours]),
);
const atlasId = (kind: FurnitureKind): string | null => {
  if (kind === "armchair" || kind === "tv" || kind === "lamp" || kind === "plant" || kind === "rug") return null;
  return kind === "runner" ? "rug" : kind;
};
const coloursOf = (kind: FurnitureKind): readonly string[] => {
  const id = atlasId(kind);
  return id === null ? [] : (COLOURS.get(id) ?? []);
};

const sprite = (name: string): HTMLSpanElement => el("span", { className: `ui-sprite ${name}`, ariaHidden: "true" });
const same = (a: RoomLayout, b: RoomLayout): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The piece a click would put down: the held kind at the slot, facing the wall it hangs on or its default way. */
function candidate(kind: FurnitureKind, variant: number, slot: Slot): Furniture | null {
  const onWall = FURNITURE[kind].layer === "wall";
  if (onWall !== (slot.wall !== null)) return null;
  const facing = slot.wall ?? defaultFacing(kind, slot.col, slot.row);
  return variant === 0 ? { kind, col: slot.col, row: slot.row, facing } : { kind, col: slot.col, row: slot.row, facing, variant };
}

/** The placed piece at a slot: on the floor, an object over a rug; on a wall, the print in that slot. */
function indexAt(layout: RoomLayout, slot: Slot): number | null {
  if (slot.wall === null) return pieceAt(layout, slot.col, slot.row);
  const i = layout.furniture.findIndex((f) => FURNITURE[f.kind].layer === "wall" && f.col === slot.col && f.row === slot.row && f.facing === slot.wall);
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
  return { furniture: layout.furniture.map((p, i) => (i === index ? next : p)) };
}

export async function mountEditor(ctx: EditorContext): Promise<Editor> {
  const atlas: EditAtlas = await loadEditAtlas();

  let saved = ctx.saved();
  let draft = saved;
  let held: { kind: FurnitureKind; variant: number } | null = null;
  let selected: number | null = null;
  let hover: Slot | null = null;
  let tab: TrayTab["id"] = "seats";

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
  ctx.view.editLayer.addChild(grid, markers);

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
        const c = candidate(held.kind, held.variant, hover);
        if (c !== null) addMarkers(c, fits(draft, c) ? "ok" : "no");
      } else if (selected !== null && sel !== undefined && indexAt(draft, hover) === null) {
        const next = moved(draft, selected, hover);
        addMarkers({ ...sel, col: hover.col, row: hover.row, facing: hover.wall ?? sel.facing }, next === null ? "no" : "ok");
      }
    }
    ctx.view.redraw();
  };

  // ---- Click layer over the stage.
  const hit = el("div", { className: "editor-hit" }, "editor-hit");
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
    if (s === null) return;
    say("");
    if (held !== null) {
      const c = candidate(held.kind, held.variant, s);
      const next = c === null ? null : place(draft, c);
      if (next === null) {
        say(c === null ? `The ${NAMES[held.kind].toLowerCase()} can't go there.` : "That spot is taken or off the floor.");
        return;
      }
      held = null;
      setDraft(next, next.furniture.length - 1);
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
  });
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
      const colour = coloursOf(kind)[0];
      b.append(colour === undefined ? el("span", { className: "editor-slot-name", textContent: NAMES[kind] }) : sprite(`ui-thumb-${atlasId(kind) ?? kind}-${colour}`));
      b.addEventListener("click", () => {
        if (b.ariaDisabled === "true") return;
        held = held?.kind === kind ? null : { kind, variant: 0 };
        selected = null;
        refresh();
      });
      slots.set(kind, b);
    }
  }
  tray.append(...slots.values());

  const pickedName = el("p", { className: "editor-picked" }, "editor-picked");
  const swatches = el("div", { className: "ui-swatches", role: "radiogroup", ariaLabel: "Colour" });
  const rotateBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Turn" }, "editor-rotate");
  const removeBtn = el("button", { type: "button", className: "ui-button secondary", textContent: "Put back" }, "editor-remove");
  const count = el("p", { className: "editor-count" }, "editor-count");
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
  removeBtn.addEventListener("click", () => {
    if (selected === null) return;
    setDraft(remove(draft, selected), null);
  });
  saveBtn.addEventListener("click", () => {
    if (problems(draft).length > 0 || same(draft, saved)) return;
    if (ctx.send({ type: "layout-set", layout: draft })) say("Saving…");
    else say("Not connected. Try again in a moment.");
  });
  resetBtn.addEventListener("click", () => {
    setDraft(saved, null);
  });
  const piecePanel = el("div", { className: "editor-piece" });
  piecePanel.append(pickedName, swatches, rotateBtn, removeBtn);
  const savePanel = el("div", { className: "editor-save-row" });
  savePanel.append(count, saveBtn, resetBtn, message);

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
  });
  confirmBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    roomMessage.textContent = "Deleting…";
    // On success the server closes everyone's socket with 4004, and room.ts shows the closed card.
    void deleteRoom().then((text) => {
      confirmBtn.disabled = false;
      roomMessage.textContent = text;
    });
  });
  const deleteRoom = async (): Promise<string> => {
    try {
      const res = await ctx.fetch(`${ctx.serverUrl}/rooms/${ctx.roomId}`, { method: "DELETE", headers: { authorization: `Bearer ${ctx.ownerToken}` } });
      const parsed = v.safeParse(DeleteRoomResponseSchema, await res.json());
      if (!parsed.success) return DELETE_ERRORS.unavailable;
      return parsed.output.ok ? "Room deleted." : DELETE_ERRORS[parsed.output.error.code];
    } catch {
      return "Couldn't reach the server. Try again.";
    }
  };

  root.append(tabs, tray, piecePanel, problemList, savePanel, settings);
  ctx.panel.replaceChildren(root);

  function say(text: string): void {
    message.textContent = text;
  }

  function setDraft(next: RoomLayout, select: number | null): void {
    draft = next;
    selected = select;
    ctx.preview(same(draft, saved) ? null : draft);
    refresh();
  }

  function refresh(): void {
    const kinds = TRAY_TABS.find((t) => t.id === tab)?.kinds ?? [];
    tabButtons.forEach((b, i) => {
      b.ariaSelected = String(TRAY_TABS[i]?.id === tab);
    });
    const full = draft.furniture.length >= MAX_FURNITURE;
    for (const [kind, b] of slots) {
      b.hidden = !kinds.includes(kind);
      b.ariaPressed = String(held?.kind === kind);
      b.ariaDisabled = String(full);
    }
    const piece = selected === null ? undefined : draft.furniture[selected];
    const kind = held?.kind ?? piece?.kind;
    const variant = held?.variant ?? piece?.variant ?? 0;
    pickedName.textContent = held !== null ? `${NAMES[held.kind]}: click the room to place it` : piece !== undefined ? NAMES[piece.kind] : "Pick a piece in the room or the tray";
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
                held = { kind: held.kind, variant: i };
                refresh();
              } else if (selected !== null && piece !== undefined) {
                const recoloured: Furniture = { ...piece, variant: i };
                setDraft({ furniture: draft.furniture.map((p, j) => (j === selected ? recoloured : p)) }, selected);
              }
            });
            return b;
          })),
    );
    const found = problems(draft);
    problemList.replaceChildren(...found.map((p) => el("li", { textContent: problemText(p) })));
    count.textContent = `${String(draft.furniture.length)} / ${String(MAX_FURNITURE)} pieces`;
    const dirty = !same(draft, saved);
    saveBtn.disabled = !dirty || found.length > 0;
    resetBtn.disabled = !dirty;
    hit.classList.toggle("holding", held !== null);
    drawMarkers();
  }

  refresh();

  return {
    update() {
      const nextSaved = ctx.saved();
      if (nextSaved !== saved) {
        const landed = same(nextSaved, draft);
        const wasDirty = !same(draft, saved);
        saved = nextSaved;
        // Our save came back: the draft is the room now. A save from elsewhere replaces an untouched draft only.
        if (landed) say("Saved.");
        if (landed || !wasDirty) setDraft(saved, landed ? selected : null);
        else refresh();
      }
      const title = ctx.title();
      if (title !== null && document.activeElement !== titleInput && titleInput.value !== title) titleInput.value = title;
      if (title !== null && roomMessage.textContent === "Renaming…" && titleInput.value === title) roomMessage.textContent = "Renamed.";
    },
    destroy() {
      ctx.preview(null);
      hit.remove();
      root.remove();
      ctx.view.editLayer.removeChildren();
      grid.destroy({ children: true });
      markers.destroy({ children: true });
      ctx.view.redraw();
    },
  };
}
