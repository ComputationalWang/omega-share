// Chat bubbles painted on the room canvas (OME-2307 3c, Doorstep desk 3): the `bubble/float` 9-slices (assets/ui/slices),
// the tail, the words, the typing dots, the speaker's edge, the self rim and the mention ring, in one layer over the name
// tags. The DOM bubble stays as the layout model (bubbles/floats.ts: sizes from a ResizeObserver, stacking, the step
// clock) and paints nothing; floats tells this layer each slot's box top-left and opacity on the writes it already
// makes, so a rise step sets a sprite's position and alpha and nothing else.
// Like the tags (scene-tags.ts) each bubble is one sprite over a small canvas of its own, drawn with the 2D API only when
// its look or the whole-number scale changes, never per frame: Pixi's Text and NineSliceSprite would add ~16 KB gzipped.
// Pooled by floats' slot: 16 sprites, made on first use.
import { CanvasSource, Sprite, Texture, type Container } from "pixi.js";
import { sameLook, type BubbleLook, type BubblePaint } from "./bubbles/floats";
import { fitText } from "./scene-tags";

/** The 9-slice's insets (reference.css `.ui-float`: border 5 5 6 5, padding 0 1) and the line height (12px/15px type). */
const L = 5;
const T = 5;
const R = 5;
const B = 6;
const PAD = 1;
const LINE = 15;
/** reference.css `.ui-float`: max-width 168 px border-box, three lines. */
const MAX_W = 168;
const MAX_LINES = 3;
/** The space the canvas keeps past the box: the tail leans out up to 5 px sideways and hangs 4 under, the mention ring 3 around. */
const MX = 6;
const MT = 3;
const MB = 4;
const TAIL_W = 12;
const TAIL_H = 7;
/** The tail's left edge from its tip x (reference.css `left: calc(var(--tail-x) - …)`, inside the padding box), and its top (100% + 3 px). */
const TAIL_LEFT = { s: 6, sw: 1, se: 11 } as const;
/** `.ui-float` colours: reference.css `--ui-bubble-text`, `--ui-accent`; the thought's cream and rim (room.css). */
const INK = "#2b1d2f";
const ACCENT = "#e8b33c";
const CREAM = "#f4ead2";
const RIM = "#f7d36b";
const FONT = "system-ui, sans-serif";
/** `.who`'s margin after the name. */
const WHO_GAP = 0.35 * 12;

/**
 * `text` wrapped into at most `maxLines` lines of `max` px (the first `indent` px shorter, for the speaker's name), the
 * last cut with an ellipsis, as the DOM's `overflow-wrap: anywhere` and `line-clamp` did: a word too long for a line breaks anywhere.
 */
export function wrapLines(text: string, max: number, indent: number, maxLines: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  let line = "";
  let room = max - indent;
  const next = (): void => {
    out.push(line);
    line = "";
    room = max;
  };
  for (const word of text.split(" ")) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (width(joined) <= room) {
      line = joined;
      continue;
    }
    // The name leaves the first line no room for the word: it starts the next.
    if (line !== "" || (out.length === 0 && indent > 0)) next();
    let rest = word;
    while (width(rest) > room) {
      let n = Math.max(1, rest.length - 1);
      while (n > 1 && width(rest.slice(0, n)) > room) n--;
      line = rest.slice(0, n);
      next();
      rest = rest.slice(n);
    }
    line = rest;
  }
  out.push(line);
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines - 1);
  kept.push(fitText(out.slice(maxLines - 1).join(" "), maxLines === 1 ? max - indent : max, width));
  return kept;
}

/** The frames, as decoded slice images. */
export interface BubbleFrames {
  readonly plain: HTMLImageElement;
  readonly self: HTMLImageElement;
  readonly tail: { readonly s: HTMLImageElement; readonly sw: HTMLImageElement; readonly se: HTMLImageElement };
}

export interface SceneBubbles extends BubblePaint {
  /** Hide them all (e2e shots of the room without bubbles). */
  hide(hidden: boolean): void;
  /** Each painted bubble's box (stage px), by slot. */
  rects(): { slot: number; look: BubbleLook; x: number; y: number; w: number; h: number }[];
}

/** Draw `img`, a 9-slice with insets `l t r b`, over (0, 0)–(w, h) at whole scale `k`. */
function nine(g: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, k: number): void {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const cols = [[0, L, 0, L * k], [L, sw - R, L * k, w - R * k], [sw - R, sw, w - R * k, w]] as const;
  const rows = [[0, T, 0, T * k], [T, sh - B, T * k, h - B * k], [sh - B, sh, h - B * k, h]] as const;
  for (const [sx0, sx1, dx0, dx1] of cols) for (const [sy0, sy1, dy0, dy1] of rows) g.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
}

interface Node {
  readonly sprite: Sprite;
  readonly canvas: HTMLCanvasElement;
  readonly source: CanvasSource;
  look: BubbleLook | null;
  /** The box top-left (stage px), as placed. */
  x: number;
  y: number;
}

export function createSceneBubbles(layer: Container, frames: BubbleFrames): SceneBubbles {
  const nodes: (Node | undefined)[] = [];
  const make = (): Node => {
    const canvas = document.createElement("canvas");
    const source = new CanvasSource({ resource: canvas, scaleMode: "nearest" });
    const sprite = new Sprite({ texture: new Texture({ source }), label: "bubble", visible: false });
    layer.addChild(sprite);
    return { sprite, canvas, source, look: null, x: 0, y: 0 };
  };
  const draw = (n: Node, l: BubbleLook): void => {
    // Drawn at the next whole scale so pixels and text stay crisp, and shown at `l.k` (the sprite's scale).
    const k = Math.ceil(l.k - 1e-6);
    const cw = Math.round((l.w + 2 * MX) * k);
    const ch = Math.round((l.h + MT + MB) * k);
    // The source sizes the canvas (and its texture's frame) before the drawing: resizing clears it.
    if (n.canvas.width !== cw || n.canvas.height !== ch) {
      n.source.resize(cw, ch, 1);
      // A texture's frame is fixed when it's made: a new one over the same source (only on a size change).
      const old = n.sprite.texture;
      n.sprite.texture = new Texture({ source: n.source });
      old.destroy(false);
    }
    const g = n.canvas.getContext("2d");
    if (g === null) return;
    g.clearRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = false;
    g.translate(MX * k, MT * k);
    const w = l.w * k;
    const h = l.h * k;
    if (l.think) {
      // room.css `.is-think`: a cream cloud in a 2 px ink rim, a self one with a mustard line inside.
      const r = 12 * k;
      g.fillStyle = INK;
      g.beginPath();
      g.roundRect(-2 * k, -2 * k, w + 4 * k, h + 4 * k, r + 2 * k);
      g.fill();
      g.fillStyle = CREAM;
      g.beginPath();
      g.roundRect(0, 0, w, h, r);
      g.fill();
      if (l.self) {
        g.strokeStyle = RIM;
        g.lineWidth = 2 * k;
        g.beginPath();
        g.roundRect(k, k, w - 2 * k, h - 2 * k, r - k);
        g.stroke();
      }
    } else nine(g, l.self ? frames.self : frames.plain, w, h, k);
    // The speaker's colour: 2 px, in the frame under the text (room.css `.ui-float::before`).
    if (l.tint !== "") {
      g.fillStyle = l.tint;
      g.fillRect(2 * k, 6 * k, 2 * k, (l.h - 13) * k);
    }
    // The mention ring (OME-1531): 2 px, 1 px clear of the box.
    if (l.mention) {
      g.strokeStyle = ACCENT;
      g.lineWidth = 2 * k;
      g.strokeRect(-2 * k, -2 * k, w + 4 * k, h + 4 * k);
    }
    if (l.tail !== "") {
      const left = (L + l.tailX - TAIL_LEFT[l.tail]) * k;
      const top = (l.h - 3) * k;
      if (l.think) {
        // The thought's tail: two small rings trailing to the speaker.
        for (const [cx, cy, ro, ri] of [[8.4, 2.1, 4, 2.5], [3.6, 6, 2.5, 1]] as const) {
          g.fillStyle = INK;
          g.beginPath();
          g.arc(left + cx * k, top + cy * k, ro * k, 0, 2 * Math.PI);
          g.fill();
          g.fillStyle = CREAM;
          g.beginPath();
          g.arc(left + cx * k, top + cy * k, ri * k, 0, 2 * Math.PI);
          g.fill();
        }
      } else g.drawImage(frames.tail[l.tail], left, top, TAIL_W * k, TAIL_H * k);
    }
    g.fillStyle = INK;
    const x0 = (L + PAD) * k;
    if (l.typing) {
      // room.css `.dots`: three 4 px dots, 3 px apart, 2 px in; the lit one full, the others 0.35.
      for (let i = 0; i < 3; i++) {
        g.globalAlpha = l.dot < 0 || l.dot === i ? 1 : 0.35;
        g.beginPath();
        g.arc((L + PAD + 2 + 2 + i * 7) * k, (T + LINE / 2) * k, 2 * k, 0, 2 * Math.PI);
        g.fill();
      }
      g.globalAlpha = 1;
    } else {
      const font = (px: number, weight: number): string => `${l.action || l.think ? "italic " : ""}${String(weight)} ${String(px)}px ${FONT}`;
      // Break the words by the layout size (12 px type), then draw them at the scale.
      const weight = l.shout ? 800 : 500;
      g.font = font(12, 700);
      const whoW = l.who === "" ? 0 : g.measureText(l.who).width + WHO_GAP;
      g.font = font(12, weight);
      const lines = wrapLines(l.text, MAX_W - L - R - 2 * PAD, whoW, MAX_LINES, (s) => g.measureText(s).width);
      g.textBaseline = "middle";
      if (l.shout) g.letterSpacing = `${String(0.48 * k)}px`;
      lines.forEach((line, i) => {
        const y = (T + LINE * i + LINE / 2) * k;
        if (i === 0 && l.who !== "") {
          g.font = font(12 * k, 700);
          g.fillText(l.who, x0, y);
          g.font = font(12 * k, weight);
          g.fillText(line, x0 + whoW * k, y);
        } else {
          g.font = font(12 * k, weight);
          g.fillText(line, x0, y);
        }
      });
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    n.source.update();
  };
  return {
    look(slot, l) {
      const n = (nodes[slot] ??= make());
      if (sameLook(n.look, l)) return false;
      const k = Math.ceil(l.k - 1e-6);
      n.look = l;
      n.sprite.scale.set(l.k / k);
      draw(n, l);
      n.sprite.visible = true;
      n.sprite.position.set(n.x - MX * l.k, n.y - MT * l.k);
      return true;
    },
    place(slot, x, y, alpha) {
      const n = (nodes[slot] ??= make());
      n.x = x;
      n.y = y;
      const k = n.look?.k ?? 1;
      n.sprite.position.set(x - MX * k, y - MT * k);
      n.sprite.alpha = alpha;
    },
    drop(slot) {
      const n = nodes[slot];
      if (n === undefined) return;
      n.sprite.visible = false;
      n.look = null;
    },
    hide(hidden) {
      layer.visible = !hidden;
    },
    rects() {
      return nodes.flatMap((n, slot) => (n?.look == null || !n.sprite.visible ? [] : [{ slot, look: n.look, x: n.x, y: n.y, w: n.look.w * n.look.k, h: n.look.h * n.look.k }]));
    },
  };
}
