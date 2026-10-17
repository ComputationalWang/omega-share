// The phone's room window (OME-596, set k `ui-m7-watch`): the stage at 1× behind a crop you drag sideways. Off the phone
// it's inert and the stage is scaled to fit as before (room.ts `fit`). A drag only moves the stage's transform (no
// layout, no canvas redraw), at most once a frame: a burst of pointer moves between two frames dirties style once, so the
// hit tests in between stay cheap. A tap that didn't drag still reaches the seat under it, and keyboard focus on anything
// in the stage pans it into view.
// Zoom (OME-1184): two fingers pinch the window around their midpoint, from the whole stage on screen to 2×, and three
// keys do the same for people who can't pinch. It's the same one transform (a scale after the translate), so it's
// compositor work like the drag; the readable-label counter-scale (--label-scale, room.css) is restyled once a pinch
// ends, never per frame. The zoom is this viewer's: kept in localStorage, never sent.
import { el } from "./controls/dom";
import { PHONE_ROOM_MIN_H, clampZoom, labelScale, minZoom, panTo, pinchView, readZoom, type Point } from "./layout";

/** A press that moves less than this is a tap (it sits); more is a drag (it pans, and its click is dropped). */
const DRAG_SLOP = 8;
/** How close to the window's edge a focused element may sit before the window pans to it. */
const REVEAL_MARGIN = 32;
/** One zoom key press. */
const ZOOM_STEP = 1.25;
export const ZOOM_STORAGE_KEY = "omega.roomZoom";
/** The zoom keys' own band in the window, 44 px keys and 4 px gaps: over the room they hid seats (QA OME-1300 F3). */
const KEYS_BAND = 52;
/** A column beside the room needs three keys' height; a shorter window has them in a row under the room. */
const KEYS_COLUMN_H = 3 * 44 + 4 * 4;

function storedZoom(): number | null {
  try {
    return readZoom(localStorage.getItem(ZOOM_STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeZoom(z: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(z));
  } catch {
    // Storage off (private mode): it's kept for this page only.
  }
}

export interface RoomWindow {
  /** Phone on/off, and the window's size in CSS px. Keeps the current centre and zoom. */
  set(active: boolean, w: number, h: number): void;
  /** Look at `p` (stage px), clamped to the stage. */
  centre(p: Point): void;
  /** Where the window looks now (stage px, top-left), for checks. */
  readonly pan: () => Point;
}

export function createRoomWindow(clip: HTMLElement, stage: HTMLElement, home: (h: number) => Point, onLabels: (k: number) => void = () => undefined): RoomWindow {
  let active = false;
  const view = { w: 0, h: 0 };
  let pan: Point = { x: 0, y: 0 };
  /** Null until someone moves it: then it follows `home` (the middle of the seats) across layouts and resizes. */
  let looking: Point | null = null;
  let zoom = storedZoom() ?? 1;
  // The stage's own pane, clipped beside (or above) the keys' band, so no key ever sits on a seat.
  const pane = el("div", { className: "stage-pane" });
  stage.before(pane);
  pane.append(stage);
  // In the window, a seat or name tag the pane crops is inert: no finger or focus lands on a sliver of it (QA OME-1324
  // G3). The browser tracks the crossings off the main thread, so a drag costs nothing here. A tag's 44 px ::before
  // (room.css) reaches 16 px past its 20 px box, hence the tighter root for tags. Off the phone nothing is made inert.
  const cropped = new Set<HTMLElement>();
  const crop = (e: HTMLElement): void => {
    e.inert = active && cropped.has(e);
  };
  const watch = (margin: string): IntersectionObserver =>
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!(e.target instanceof HTMLElement)) continue;
        if (e.intersectionRatio < 0.99) cropped.add(e.target);
        else cropped.delete(e.target);
        crop(e.target);
      }
    }, { root: pane, rootMargin: margin, threshold: 0.99 });
  const seatsSeen = watch("0px");
  const tagsSeen = watch("-16px");
  for (const s of stage.querySelectorAll(".seat")) seatsSeen.observe(s);
  const tagLayer = stage.querySelector(".tags");
  if (tagLayer !== null) {
    for (const t of tagLayer.querySelectorAll(".tag")) tagsSeen.observe(t);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains("tag")) tagsSeen.observe(n);
        for (const n of r.removedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          tagsSeen.unobserve(n);
          cropped.delete(n);
        }
      }
    }).observe(tagLayer, { childList: true });
  }

  const apply = (): void => {
    zoom = clampZoom(zoom, view);
    pan = panTo(view, looking ?? home(view.h / zoom), zoom);
    stage.style.transform = `translate(${String(-pan.x * zoom)}px, ${String(-pan.y * zoom)}px) scale(${String(zoom)})`;
  };
  /** The window's centre now, stage px. */
  const shown = (): Point => ({ x: pan.x + view.w / (2 * zoom), y: pan.y + view.h / (2 * zoom) });
  const centre = (p: Point): void => {
    if (!active) return;
    looking = p;
    apply();
    // The clamp may have moved it: keep the centre we actually show, so a drag starts from what's on screen.
    looking = shown();
  };
  /** The label scale the stage has now (null: unset, off the phone). */
  let labels: number | null = null;
  /** Restyle the labels for the zoom (one style pass, not per frame), and tell the bubbles (floats.ts `scale`). */
  const settleLabels = (): void => {
    const k = labelScale(zoom);
    if (k === labels) return;
    labels = k;
    stage.style.setProperty("--label-scale", String(k));
    onLabels(k);
  };
  /** A zoom the viewer chose: around the window's centre, its labels settled, and remembered. */
  const zoomTo = (z: number): void => {
    if (!active) return;
    zoom = z;
    // A window that follows the seats keeps following them (a zoom isn't a move); one that was moved stays put.
    if (looking === null) apply();
    else centre(looking);
    settleLabels();
    storeZoom(zoom);
  };

  const keys = el("div", { className: "room-zoom", hidden: true });
  const key = (name: string, label: string, text: string, next: () => number): void => {
    const k = el("button", { type: "button", className: "ui-button", ariaLabel: label, title: label, textContent: text }, `room-zoom-${name}`);
    k.addEventListener("click", () => {
      zoomTo(next());
    });
    keys.append(k);
  };
  key("in", "Zoom in", "+", () => zoom * ZOOM_STEP);
  key("out", "Zoom out", "−", () => zoom / ZOOM_STEP);
  key("fit", "Fit the room", "Fit", () => minZoom(view));
  clip.append(keys);

  let down: { id: number; x: number; from: Point } | null = null;
  let dragged = false;
  /** The latest drag position not yet drawn (client x), and the frame that draws it. */
  let dragX = 0;
  let dragFrame = 0;
  const drawDrag = (): void => {
    dragFrame = 0;
    if (down !== null) centre({ x: down.from.x - (dragX - down.x) / zoom, y: down.from.y });
  };

  /** Fingers on the window (client px), and the pinch two of them make: where it started, and its pending frame. */
  const fingers = new Map<number, Point>();
  let pinch: { zoom: number; at: Point; dist: number; left: number; top: number } | null = null;
  let pinchFrame = 0;
  const two = (): { dist: number; mid: Point } | null => {
    const [a, b] = fingers.values();
    if (a === undefined || b === undefined) return null;
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const drawPinch = (): void => {
    pinchFrame = 0;
    const now = two();
    if (pinch === null || now === null) return;
    const v = pinchView(pinch, { dist: now.dist, mid: { x: now.mid.x - pinch.left, y: now.mid.y - pinch.top } }, view);
    zoom = v.zoom;
    centre(v.centre);
  };
  // Two fingers are the pinch's, never the page's: the browser would otherwise scroll a pinch that starts vertically
  // (touch-action pan-y). One finger is never stopped, so a vertical swipe still scrolls the page.
  clip.addEventListener(
    "touchmove",
    (ev) => {
      if (active && ev.touches.length > 1) ev.preventDefault();
    },
    { passive: false },
  );

  clip.addEventListener("pointerdown", (ev) => {
    if (!active) return;
    if (ev.pointerType === "touch") fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const start = fingers.size >= 2 && pinch === null ? two() : null;
    if (start !== null) {
      // A second finger: the drag (if any) becomes a pinch, and nothing under the fingers is tapped.
      if (dragFrame !== 0) cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      down = null;
      dragged = true;
      clip.classList.remove("is-dragging");
      const r = pane.getBoundingClientRect();
      pinch = { zoom, at: { x: pan.x + (start.mid.x - r.left) / zoom, y: pan.y + (start.mid.y - r.top) / zoom }, dist: start.dist, left: r.left, top: r.top };
      for (const id of fingers.keys()) clip.setPointerCapture(id);
      return;
    }
    if (!ev.isPrimary || ev.button !== 0) return;
    down = { id: ev.pointerId, x: ev.clientX, from: shown() };
    dragged = false;
  });
  clip.addEventListener("pointermove", (ev) => {
    if (fingers.has(ev.pointerId)) fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch !== null) {
      if (pinchFrame === 0) pinchFrame = requestAnimationFrame(drawPinch);
      return;
    }
    if (down?.id !== ev.pointerId) return;
    const dx = ev.clientX - down.x;
    if (!dragged && Math.abs(dx) < DRAG_SLOP) return;
    if (!dragged) {
      dragged = true;
      clip.setPointerCapture(ev.pointerId);
      clip.classList.add("is-dragging");
    }
    dragX = ev.clientX;
    if (dragFrame === 0) dragFrame = requestAnimationFrame(drawDrag);
  });
  const end = (ev: PointerEvent): void => {
    if (pinch !== null && fingers.has(ev.pointerId)) {
      // Where the fingers let go is where the zoom stays; the last finger up drops the pinch's click, as a drag's.
      if (pinchFrame !== 0) cancelAnimationFrame(pinchFrame);
      drawPinch();
      pinch = null;
      settleLabels();
      storeZoom(zoom);
    }
    fingers.delete(ev.pointerId);
    if (fingers.size === 0 && dragged && down === null) setTimeout(() => {
      dragged = false;
    }, 0);
    if (down?.id !== ev.pointerId) return;
    // Where the finger let go is where the window stays.
    if (dragFrame !== 0) {
      cancelAnimationFrame(dragFrame);
      drawDrag();
    }
    down = null;
    clip.classList.remove("is-dragging");
    // A mouse drag's click comes in this same task, right after pointerup; a finger drag sends none. Either way the drop
    // ends here, so it can never eat a later click (a keyboard Enter on a seat, a switch or screen-reader activation).
    if (dragged) setTimeout(() => {
      dragged = false;
    }, 0);
  };
  clip.addEventListener("pointerup", end);
  // A finger the window lost (capture taken away, an up it never heard) is gone, and so is a pinch it was part of. Only
  // the window's own capture: the event bubbles, and a seat losing a finger to the pinch is how a pinch starts (OME-1197).
  clip.addEventListener("lostpointercapture", (ev) => {
    if (ev.target === clip && fingers.has(ev.pointerId)) end(ev);
  });
  clip.addEventListener("pointercancel", (ev) => {
    end(ev);
    dragged = false;
  });
  // A drag's click would sit on whatever seat it ended over: drop it, before the seat layer sees it. Only a pointer's
  // click (detail > 0): keyboard and assistive-tech clicks have detail 0 and always go through.
  clip.addEventListener(
    "click",
    (ev) => {
      if (!dragged || ev.detail === 0) return;
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
    const x = (r.left - s.left + r.width / 2) / zoom;
    const y = (r.top - s.top + r.height / 2) / zoom;
    const m = REVEAL_MARGIN / zoom;
    const inside = x - pan.x >= m && pan.x + view.w / zoom - x >= m && y - pan.y >= m && pan.y + view.h / zoom - y >= m;
    if (!inside) centre({ x, y });
  });

  return {
    set(on, w, h) {
      if (on !== active) for (const e of cropped) e.inert = on;
      active = on;
      const column = h >= KEYS_COLUMN_H;
      view.w = on && column ? Math.max(0, w - KEYS_BAND) : w;
      view.h = on && !column ? Math.max(0, h - KEYS_BAND) : h;
      clip.dataset["keys"] = column ? "column" : "row";
      clip.classList.toggle("is-phone", on);
      // Too short for a window (portrait-dock under an open panel): no room at all, rather than a sliver (QA OME-1300 F4).
      clip.style.visibility = on && h < PHONE_ROOM_MIN_H ? "hidden" : "";
      keys.hidden = !on;
      if (on) {
        apply();
        settleLabels();
      } else {
        down = null;
        dragged = false;
        pinch = null;
        fingers.clear();
        stage.style.removeProperty("--label-scale");
        if (labels !== null && labels !== 1) onLabels(1);
        labels = null;
      }
    },
    centre,
    pan: () => pan,
  };
}
