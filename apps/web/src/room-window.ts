// The phone's room window (OME-596, set k `ui-m7-watch`): the stage at 1× behind a crop you drag sideways. Off the phone
// it's inert and the stage is scaled to fit as before (room.ts `fit`). A drag only moves the stage's transform (no
// layout, no canvas redraw), at most once a frame: a burst of pointer moves between two frames dirties style once, so the
// hit tests in between stay cheap. A tap that didn't drag still reaches the seat under it, and keyboard focus on anything
// in the stage pans it into view.
// Zoom (OME-1184): two fingers pinch the window around their midpoint, from the whole stage on screen to 2×, and three
// keys do the same for people who can't pinch. It's the same one transform (a scale after the translate), so it's
// compositor work like the drag; the readable-label counter-scale (--label-scale, room.css) is restyled once a pinch
// ends, never per frame. The zoom is this viewer's: kept in localStorage, never sent.
// On a computer (OME-1490, `desk`) the room is fitted as before, and the wheel zooms it from there, up to MAX_ZOOM× the
// fit, around the pointer (`wheelView`): a trackpad pinch (a ctrlKey wheel) too, never the page's. The wheel is summed
// and drawn once a frame, the transform alone. Zoomed in, the Fit key shows in the room's corner and goes back to the
// whole room (a double-click on the floor is a jog, OME-1350). Its own key in localStorage, as its zoom is a multiple of
// the fit, not the phone's stage scale. At an integer scale (OME-1811) the room can be bigger than its band: then the view
// starts on the seats, a mouse drag looks around (both ways, the same once-a-frame transform), and Fit goes back.
import { el } from "./controls/dom";
import { PHONE_ROOM_MIN_H, ROOM_VIEW, STAGE_H, STAGE_W, clampZoom, labelScale, minZoom, panTo, pinchView, readZoom, wheelView, type DeskView, type Point } from "./layout";

/** A press that moves less than this is a tap (it sits); more is a drag (it pans, and its click is dropped). */
const DRAG_SLOP = 8;
/** How close to the window's edge a focused element may sit before the window pans to it. */
const REVEAL_MARGIN = 32;
/** A focus this soon after a press in the window is the press's own (a tap's comes after the finger lifts). */
const PRESS_FOCUS_MS = 1000;
/** One zoom key press. */
const ZOOM_STEP = 1.25;
export const ZOOM_STORAGE_KEY = "omega.roomZoom";
const DESK_ZOOM_STORAGE_KEY = "omega.roomZoomDesk";
/** The wheel's zoom per px of deltaY (a mouse notch, 100 px, is about one zoom key), and a trackpad pinch's. */
const WHEEL_RATE = 0.0022;
const PINCH_RATE = 0.01;
/** The zoom keys' own band in the window, 44 px keys and 4 px gaps: over the room they hid seats (QA OME-1300 F3). */
const KEYS_BAND = 52;
/** A column beside the room needs three keys' height; a shorter window has them in a row under the room. */
export const KEYS_COLUMN_H = 3 * 44 + 4 * 4;
/** The keys in a row beside the room (a wide short window): three 44 px keys, their gaps and the band's edges. */
const KEYS_ROW_W = 3 * 44 + 4 * 4;
/** From this width a short window has its keys beside the room, not under it (a phone held sideways, OME-1841); a portrait
 * phone's window (≤ 430 px) keeps them under it. */
const KEYS_SIDE_MIN_W = 480;

/**
 * The window's height in a wide column with `avail` px left under the shelf (OME-1841): all of it if the room shows there
 * beside its keys, so the column never scrolls; else the keys' column height, scrolled to (Twitch's taller TV, QA OME-1330 R1).
 */
export function windowH(w: number, avail: number): number {
  return w >= KEYS_SIDE_MIN_W && avail >= PHONE_ROOM_MIN_H ? avail : Math.max(KEYS_COLUMN_H, avail);
}
/** How far inside the pane a tag's box must sit to be whole to the finger: its 52 px ::before less its 20 px height, halved. */
const TAG_CROP = 16;

function storedZoom(key = ZOOM_STORAGE_KEY): number | null {
  try {
    return readZoom(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function storeZoom(z: number, key = ZOOM_STORAGE_KEY): void {
  try {
    localStorage.setItem(key, String(z));
  } catch {
    // Storage off (private mode): it's kept for this page only.
  }
}

export interface RoomWindow {
  /** Phone on/off, and the window's size in CSS px. Keeps the current centre and zoom. */
  set(active: boolean, w: number, h: number): void;
  /** Look at `p` (stage px), clamped to the stage. */
  centre(p: Point): void;
  /**
   * Off the phone (OME-1490): the room at `scale` in a `box` (CSS px, default its whole ROOM_VIEW); the wheel zooms it
   * from there. A box smaller than the room (OME-1811's band) looks at the seats first, and a drag looks around.
   */
  desk(scale: number, box?: { readonly w: number; readonly h: number }): void;
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
  /** Off the phone: the room's fitted scale, and the wheel's zoom over it (null on the phone, or before the first fit). */
  let desk: number | null = null;
  const roomTopLeft: Point = { x: ROOM_VIEW.x, y: ROOM_VIEW.y };
  let deskView: DeskView = { zoom: storedZoom(DESK_ZOOM_STORAGE_KEY) ?? 1, pan: roomTopLeft };
  /** The room's box off the phone (CSS px): ROOM_VIEW at the fit, or a band smaller than the room (OME-1811). */
  let deskBox = { w: 0, h: 0 };
  /** Off the phone, whether the viewer moved the view (wheel, drag): until then it follows `home`, as the phone's does. */
  let deskMoved = false;
  const keys = el("div", { className: "room-zoom", hidden: true });
  const showDesk = (fit: number): void => {
    const k = fit * deskView.zoom;
    stage.style.transform = `translate(${String(-deskView.pan.x * k)}px, ${String(-deskView.pan.y * k)}px) scale(${String(k)})`;
    keys.hidden = deskView.zoom <= 1 && !deskMoved;
  };
  const applyDesk = (fit: number, v: DeskView): void => {
    deskView = wheelView(fit, v, { x: 0, y: 0 }, v.zoom, deskBox);
    showDesk(fit);
  };
  /** Off the phone at `zoom`: the view centred on the seats (clamped to the room by applyDesk). */
  const deskHome = (fit: number, zoom: number): DeskView => {
    const k = fit * zoom;
    const c = home(deskBox.h / k);
    return { zoom, pan: { x: c.x - deskBox.w / (2 * k), y: c.y - deskBox.h / (2 * k) } };
  };
  /** The band shows less than the whole room at the fit: a drag looks around it. */
  const deskPans = (): boolean => desk !== null && (deskBox.w < ROOM_VIEW.w * desk - 0.5 || deskBox.h < ROOM_VIEW.h * desk - 0.5);
  // The stage's own pane, clipped beside (or above) the keys' band, so no key ever sits on a seat.
  const pane = el("div", { className: "stage-pane" });
  stage.before(pane);
  pane.append(stage);
  // The pane is overflow: hidden (room.css), which focus may scroll: the view is the stage's transform alone.
  const unscroll = (): void => {
    pane.scrollTop = 0;
    pane.scrollLeft = 0;
  };
  pane.addEventListener("scroll", unscroll, { passive: true });
  // Off the phone the clip is the one the browser scrolls to show something in it (find in page, a screen reader, a
  // focus): in a band (OME-1811) that scroll becomes the view's pan, so what it showed stays where it is, and the clip is
  // never left scrolled under the transform.
  clip.addEventListener("scroll", () => {
    const dx = clip.scrollLeft;
    const dy = clip.scrollTop;
    if (dx === 0 && dy === 0) return;
    clip.scrollLeft = 0;
    clip.scrollTop = 0;
    if (desk === null) return;
    // Kept to the stage, not ROOM_VIEW: the browser scrolled within the stage's box and measured what it showed there.
    const k = desk * deskView.zoom;
    // A band wider than the stage keeps it centred (OME-1843).
    const keep = (v: number, max: number): number => (max < 0 ? max / 2 : Math.max(0, Math.min(max, v)));
    deskMoved = true;
    deskView = { zoom: deskView.zoom, pan: { x: keep(deskView.pan.x + dx / k, STAGE_W - deskBox.w / k), y: keep(deskView.pan.y + dy / k, STAGE_H - deskBox.h / k) } };
    showDesk(desk);
  }, { passive: true });
  // In the window, a seat the pane crops is inert: no finger or focus lands on a sliver of it (QA OME-1324 G3); the
  // rows it shows whole are enough to sit. A cropped name tag (and its hit pad) is only off to pointers: it stays in the
  // tab order, and its focus pans the window to show it whole, or an owner at 320 px couldn't reach a member's menu at
  // all (QA OME-1330 R2). The browser tracks the crossings off the main thread, so a drag costs nothing here. A tag's
  // 44 px ::before (room.css) reaches 16 px past its 20 px box, hence the tighter root for tags. Off the phone, nothing.
  const cropped = new Set<HTMLElement>();
  const crop = (e: HTMLElement): void => {
    const off = active && cropped.has(e);
    const id = e.dataset["member"];
    if (id === undefined) {
      e.inert = off;
      return;
    }
    e.classList.toggle("is-cropped", off);
    stage.querySelector(`.tag-pad[data-pad="${id}"]`)?.classList.toggle("is-cropped", off);
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
  const tagsSeen = watch(`-${String(TAG_CROP)}px`);
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

  const fitDesk = (): void => {
    if (desk === null) return;
    deskMoved = false;
    applyDesk(desk, deskHome(desk, 1));
    storeZoom(1, DESK_ZOOM_STORAGE_KEY);
  };
  const key = (name: string, label: string, text: string, next: () => number): void => {
    const k = el("button", { type: "button", className: "ui-button", ariaLabel: label, title: label, textContent: text }, `room-zoom-${name}`);
    k.addEventListener("click", () => {
      if (desk === null) zoomTo(next());
      else if (name === "fit") fitDesk();
    });
    keys.append(k);
  };
  key("in", "Zoom in", "+", () => zoom * ZOOM_STEP);
  key("out", "Zoom out", "−", () => zoom / ZOOM_STEP);
  key("fit", "Fit the room", "Fit", () => minZoom(view));
  clip.append(keys);

  /** When the last press in the window began (event time, ms). */
  let pressedAt = -Infinity;
  let down: { id: number; x: number; y: number; from: Point; deskPan: Point } | null = null;
  let dragged = false;
  /** The latest drag position not yet drawn (client x), and the frame that draws it. */
  let dragX = 0;
  let dragY = 0;
  let dragFrame = 0;
  const drawDrag = (): void => {
    dragFrame = 0;
    if (down === null) return;
    if (desk !== null) {
      // Off the phone (OME-1811): a band smaller than the room pans both ways, inside the room.
      const k = desk * deskView.zoom;
      deskMoved = true;
      applyDesk(desk, { zoom: deskView.zoom, pan: { x: down.deskPan.x - (dragX - down.x) / k, y: down.deskPan.y - (dragY - down.y) / k } });
    } else centre({ x: down.from.x - (dragX - down.x) / zoom, y: down.from.y });
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
    pressedAt = ev.timeStamp;
    if (!active && !(deskPans() || deskView.zoom > 1)) return;
    if (!active) {
      // Off the phone: a press is a drag or a click, never a pinch (the wheel and a trackpad pinch zoom here).
      if (!ev.isPrimary || ev.button !== 0) return;
      down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, from: shown(), deskPan: deskView.pan };
      dragged = false;
      return;
    }
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
    down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, from: shown(), deskPan: deskView.pan };
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
    const moved = desk === null ? Math.abs(dx) : Math.hypot(dx, ev.clientY - down.y);
    if (!dragged && moved < DRAG_SLOP) return;
    if (!dragged) {
      dragged = true;
      clip.setPointerCapture(ev.pointerId);
      clip.classList.add("is-dragging");
    }
    dragX = ev.clientX;
    dragY = ev.clientY;
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
    unscroll();
    if (desk !== null && (deskView.zoom > 1 || deskPans()) && ev.target instanceof Element) {
      // Zoomed in on a computer: something focused outside the view is centred in it.
      const r = ev.target.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const k = desk * deskView.zoom;
      const x = (r.left - s.left + r.width / 2) / k;
      const y = (r.top - s.top + r.height / 2) / k;
      const w = deskBox.w / k;
      const h = deskBox.h / k;
      const p = deskView.pan;
      if (x < p.x || x > p.x + w || y < p.y || y > p.y + h) applyDesk(desk, { zoom: deskView.zoom, pan: { x: x - w / 2, y: y - h / 2 } });
      return;
    }
    // A press's focus (a tap on a seat: a touch focuses after the finger lifts) is under the finger already: panning to it
    // slid the seat away before its click landed (OME-1841).
    if (!active || ev.timeStamp - pressedAt < PRESS_FOCUS_MS || !(ev.target instanceof Element)) return;
    const r = ev.target.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const x = (r.left - s.left + r.width / 2) / zoom;
    const y = (r.top - s.top + r.height / 2) / zoom;
    const m = REVEAL_MARGIN / zoom;
    // A tag must also clear the tags' crop margin (above) on every side, or it would stay off to pointers.
    const e = TAG_CROP / zoom;
    const whole = !(ev.target instanceof HTMLElement && ev.target.classList.contains("tag")) ||
      ((r.left - s.left) / zoom - pan.x >= e && pan.x + view.w / zoom - (r.right - s.left) / zoom >= e &&
        (r.top - s.top) / zoom - pan.y >= e && pan.y + view.h / zoom - (r.bottom - s.top) / zoom >= e);
    const inside = whole && x - pan.x >= m && pan.x + view.w / zoom - x >= m && y - pan.y >= m && pan.y + view.h / zoom - y >= m;
    if (!inside) centre({ x, y });
  });

  /** The wheel since the last frame (log zoom), where the pointer last was (client px), and the frame that draws it. */
  let wheelLog = 0;
  let wheelAt: Point = roomTopLeft;
  let wheelFrame = 0;
  const drawWheel = (): void => {
    wheelFrame = 0;
    const log = wheelLog;
    wheelLog = 0;
    if (desk === null) return;
    const r = clip.getBoundingClientRect();
    deskMoved = true;
    applyDesk(desk, wheelView(desk, deskView, { x: wheelAt.x - r.left, y: wheelAt.y - r.top }, deskView.zoom * Math.exp(log), deskBox));
    storeZoom(deskView.zoom, DESK_ZOOM_STORAGE_KEY);
  };
  // Only the room's own box hears it: the TV, chat, panels and dialogs are outside the clip and keep their scroll.
  clip.addEventListener(
    "wheel",
    (ev) => {
      if (desk === null) return;
      ev.preventDefault();
      const px = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
      wheelLog -= ev.deltaY * px * (ev.ctrlKey ? PINCH_RATE : WHEEL_RATE);
      wheelAt = { x: ev.clientX, y: ev.clientY };
      if (wheelFrame === 0) wheelFrame = requestAnimationFrame(drawWheel);
    },
    { passive: false },
  );

  return {
    set(on, w, h) {
      desk = null;
      clip.classList.remove("is-band");
      const was = active;
      active = on;
      if (on !== was) for (const e of cropped) crop(e);
      const keysAt = h >= KEYS_COLUMN_H ? "column" : w >= KEYS_SIDE_MIN_W ? "side" : "row";
      view.w = on && keysAt !== "row" ? Math.max(0, w - (keysAt === "column" ? KEYS_BAND : KEYS_ROW_W)) : w;
      view.h = on && keysAt === "row" ? Math.max(0, h - KEYS_BAND) : h;
      clip.dataset["keys"] = keysAt;
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
    desk(fit, box = { w: ROOM_VIEW.w * fit, h: ROOM_VIEW.h * fit }) {
      desk = fit;
      deskBox = box;
      clip.classList.toggle("is-band", deskPans());
      applyDesk(fit, deskMoved ? deskView : deskHome(fit, deskView.zoom));
    },
    pan: () => pan,
  };
}
