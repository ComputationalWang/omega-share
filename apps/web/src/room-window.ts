// The phone's room window (OME-596, set k `ui-m7-watch`): the stage at 1× behind a crop you drag sideways. Off the phone
// it's inert and the stage is scaled to fit as before (room.ts `fit`). A drag only moves the stage's transform (no
// layout, no canvas redraw); a tap that didn't drag still reaches the seat under it, and keyboard focus on anything in
// the stage pans it into view.
import { panTo, type Point } from "./layout";

/** A press that moves less than this is a tap (it sits); more is a drag (it pans, and its click is dropped). */
const DRAG_SLOP = 8;
/** How close to the window's edge a focused element may sit before the window pans to it. */
const REVEAL_MARGIN = 32;

export interface RoomWindow {
  /** Phone on/off, and the window's size in CSS px (= stage px: no scaling). Keeps the current centre. */
  set(active: boolean, w: number, h: number): void;
  /** Look at `p` (stage px), clamped to the stage. */
  centre(p: Point): void;
  /** Where the window looks now (stage px, top-left), for checks. */
  readonly pan: () => Point;
}

export function createRoomWindow(clip: HTMLElement, stage: HTMLElement, home: () => Point): RoomWindow {
  let active = false;
  const view = { w: 0, h: 0 };
  let pan: Point = { x: 0, y: 0 };
  /** Null until someone moves it: then it follows `home` (the middle of the seats) across layouts and resizes. */
  let looking: Point | null = null;

  const apply = (): void => {
    pan = panTo(view, looking ?? home());
    stage.style.transform = `translate(${String(-pan.x)}px, ${String(-pan.y)}px)`;
  };
  const centre = (p: Point): void => {
    if (!active) return;
    looking = p;
    apply();
    // The clamp may have moved it: keep the centre we actually show, so a drag starts from what's on screen.
    looking = { x: pan.x + view.w / 2, y: pan.y + view.h / 2 };
  };

  let down: { id: number; x: number; from: Point } | null = null;
  let dragged = false;
  clip.addEventListener("pointerdown", (ev) => {
    if (!active || !ev.isPrimary || ev.button !== 0) return;
    down = { id: ev.pointerId, x: ev.clientX, from: { x: pan.x + view.w / 2, y: pan.y + view.h / 2 } };
    dragged = false;
  });
  clip.addEventListener("pointermove", (ev) => {
    if (down?.id !== ev.pointerId) return;
    const dx = ev.clientX - down.x;
    if (!dragged && Math.abs(dx) < DRAG_SLOP) return;
    if (!dragged) {
      dragged = true;
      clip.setPointerCapture(ev.pointerId);
      clip.classList.add("is-dragging");
    }
    centre({ x: down.from.x - dx, y: down.from.y });
  });
  const end = (ev: PointerEvent): void => {
    if (down?.id !== ev.pointerId) return;
    down = null;
    clip.classList.remove("is-dragging");
  };
  clip.addEventListener("pointerup", end);
  clip.addEventListener("pointercancel", (ev) => {
    end(ev);
    dragged = false;
  });
  // A drag's click would sit on whatever seat it ended over: drop it, before the seat layer sees it.
  clip.addEventListener(
    "click",
    (ev) => {
      if (!dragged) return;
      dragged = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
    true,
  );
  // Keyboard: whatever takes focus in the stage (a seat, a name tag) is panned into the window.
  stage.addEventListener("focusin", (ev) => {
    if (!active || !(ev.target instanceof Element)) return;
    const r = ev.target.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const x = r.left - s.left + r.width / 2;
    const y = r.top - s.top + r.height / 2;
    const inside = x - pan.x >= REVEAL_MARGIN && pan.x + view.w - x >= REVEAL_MARGIN && y - pan.y >= REVEAL_MARGIN && pan.y + view.h - y >= REVEAL_MARGIN;
    if (!inside) centre({ x, y });
  });

  return {
    set(on, w, h) {
      active = on;
      view.w = w;
      view.h = h;
      clip.classList.toggle("is-phone", on);
      if (on) apply();
      else {
        down = null;
        dragged = false;
      }
    },
    centre,
    pan: () => pan,
  };
}
