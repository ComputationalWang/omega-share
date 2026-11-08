// Name tags painted on the room canvas (OME-2307, Doorstep desk 3): the `tag/0` / `tag/self` 9-slices (assets/ui/slices)
// with the nickname, the shirt-tint underline and the leader pip, in one layer over the avatars. A walker's tag moves on
// the walk frames the canvas draws anyway, so walking writes no DOM. The DOM keeps a transparent target per tag (stage.ts:
// moderation, focus, a11y) whose box gives each tag's width, so the two always match.
// Each tag is one sprite over a small canvas of its own, drawn with the 2D API only when its look, scale or pip changes:
// Pixi's Text and NineSliceSprite would add ~16 KB gzipped to the chunk a join waits for. Pooled: a member who leaves
// frees theirs for the next one.
import { CanvasSource, Sprite, Texture, type Container } from "pixi.js";
import { TAG_H } from "./layout";

/** The 9-slices' insets (assets/src/ui.ts: the tag frames are `all(4)`) and the text's inset past them (room.css padding). */
const BORDER = 4;
const PAD = 1;
/** Room over and under the tag for its leader pip (room.css had it 4 px past the edge). */
const PIP = 4;
/** room.css `.tag`: 12 px system type, semibold: on the 1× pixelated canvas the regular weight greys out. reference.css
 * colours: text, the self tag's accent, a catching tag's muted italic. */
const FONT = "system-ui, sans-serif";
const TEXT = "#fff7ea";
const ACCENT = "#e8b33c";
const MUTED = "#c6a8ec";

/** How a tag looks; the stage reads it off the DOM target. */
export interface TagLook {
  readonly text: string;
  readonly self: boolean;
  /** The shirt's colour under the name (OME-1375), or "" for none. */
  readonly tint: string;
  /** Hidden for me 0.5, away 0.6 (room.css), else 1. */
  readonly alpha: number;
  readonly catching: boolean;
  /** The DOM target's border-box width, and its name box's when the DOM cut the name (else Infinity), in stage px unscaled. */
  readonly w: number;
  readonly nameW: number;
}

export interface SceneTags {
  /** Paint a member's tag as `look`; false when it already looked so. */
  look(id: string, look: TagLook): boolean;
  /** Its top-left (stage px), its whole scale, and its leader pip: none, under the tag (`above`: it's over the head) or over it. */
  place(id: string, x: number, y: number, k: number, led: boolean, above: boolean): boolean;
  drop(id: string): void;
  /** Hide them all (e2e shots of the room without tags). */
  hide(hidden: boolean): void;
  /** Its box as placed (stage px), or undefined. */
  rect(id: string): { x: number; y: number; w: number; h: number } | undefined;
}

/** `text` cut to `max` px wide with an ellipsis, as the DOM's `text-overflow: ellipsis` does. */
export function fitText(text: string, max: number, width: (s: string) => number): string {
  if (width(text) <= max) return text;
  let n = text.length;
  while (n > 0 && width(`${text.slice(0, n)}…`) > max) n--;
  return `${text.slice(0, n)}…`;
}

/** Draw `img`, a 9-slice with `b` px insets, over (0, y)–(w, y + h) at whole scale `k`, its centre filled. */
function nine(g: CanvasRenderingContext2D, img: HTMLImageElement, b: number, y: number, w: number, h: number, k: number): void {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  // Each band's source and destination span: inset, middle (stretched), inset.
  const cols = [[0, b, 0, b * k], [b, sw - b, b * k, w - b * k], [sw - b, sw, w - b * k, w]] as const;
  const rows = [[0, b, y, y + b * k], [b, sh - b, y + b * k, y + h - b * k], [sh - b, sh, y + h - b * k, y + h]] as const;
  for (const [sx0, sx1, dx0, dx1] of cols) for (const [sy0, sy1, dy0, dy1] of rows) g.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
}

interface Node {
  readonly sprite: Sprite;
  readonly canvas: HTMLCanvasElement;
  readonly source: CanvasSource;
  look: TagLook | null;
  at: { x: number; y: number; k: number; led: boolean; above: boolean } | null;
}

export function createSceneTags(layer: Container, frames: { readonly plain: HTMLImageElement; readonly self: HTMLImageElement }): SceneTags {
  const nodes = new Map<string, Node>();
  const free: Node[] = [];
  const make = (): Node => {
    const canvas = document.createElement("canvas");
    const source = new CanvasSource({ resource: canvas, scaleMode: "nearest" });
    const sprite = new Sprite({ texture: new Texture({ source }), label: "tag" });
    layer.addChild(sprite);
    return { sprite, canvas, source, look: null, at: null };
  };
  /** Redraw a tag's canvas (its look, scale or pip changed): never per frame. */
  const draw = (n: Node): void => {
    const l = n.look;
    const a = n.at;
    if (l === null || a === null) return;
    const k = a.k;
    const w = Math.max(1, Math.round(l.w * k));
    const h = TAG_H * k;
    const top = PIP * k;
    // The source sizes the canvas (and its texture's frame) before the drawing: resizing clears it.
    if (n.canvas.width !== w || n.canvas.height !== h + 2 * top) {
      n.source.resize(w, h + 2 * top, 1);
      // A texture's frame is fixed when it's made: a new one over the same source (only on a size change, never per frame).
      const old = n.sprite.texture;
      n.sprite.texture = new Texture({ source: n.source });
      old.destroy(false);
    }
    const g = n.canvas.getContext("2d");
    if (g === null) return;
    g.clearRect(0, 0, n.canvas.width, n.canvas.height);
    g.imageSmoothingEnabled = false;
    nine(g, l.self ? frames.self : frames.plain, BORDER, top, w, h, k);
    // room.css `.tag::after`: the tint edge, 2 px, 3 px in from each side, 1 px over the bottom edge.
    if (l.tint !== "") {
      g.fillStyle = l.tint;
      g.fillRect(3 * k, top + h - k, w - 6 * k, 2 * k);
    }
    // The leader pip (OME-2172): an 8×4 triangle at the centre, just past the top edge (pointing up) or the bottom one.
    if (a.led) {
      const c = w / 2;
      const edge = a.above ? top + h : top;
      const tip = a.above ? edge + 4 * k : edge - 4 * k;
      g.fillStyle = l.tint === "" ? TEXT : l.tint;
      g.beginPath();
      g.moveTo(c - 4 * k, edge);
      g.lineTo(c + 4 * k, edge);
      g.lineTo(c, tip);
      g.fill();
    }
    g.font = `${l.catching ? "italic " : ""}600 ${String(12 * k)}px ${FONT}`;
    g.fillStyle = l.catching ? MUTED : l.self ? ACCENT : TEXT;
    g.textBaseline = "middle";
    const text = Number.isFinite(l.nameW) ? fitText(l.text, l.nameW * k, (t) => g.measureText(t).width) : l.text;
    g.fillText(text, (BORDER + PAD) * k, top + h / 2);
    n.source.update();
  };
  return {
    look(id, l) {
      let n = nodes.get(id);
      if (n === undefined) {
        n = free.pop() ?? make();
        n.sprite.visible = true;
        nodes.set(id, n);
      }
      const was = n.look;
      if (was !== null && was.text === l.text && was.self === l.self && was.tint === l.tint && was.alpha === l.alpha && was.catching === l.catching && was.w === l.w && was.nameW === l.nameW) return false;
      n.look = l;
      n.sprite.alpha = l.alpha;
      draw(n);
      return true;
    },
    place(id, x, y, k, led, above) {
      const n = nodes.get(id);
      if (n === undefined) return false;
      const a = n.at;
      if (a !== null && a.x === x && a.y === y && a.k === k && a.led === led && a.above === above) return false;
      n.at = { x, y, k, led, above };
      n.sprite.position.set(x, y - PIP * k);
      if (a?.k !== k || a.led !== led || a.above !== above) draw(n);
      return true;
    },
    drop(id) {
      const n = nodes.get(id);
      if (n === undefined) return;
      nodes.delete(id);
      n.sprite.visible = false;
      n.look = null;
      n.at = null;
      free.push(n);
    },
    hide(hidden) {
      layer.visible = !hidden;
    },
    rect(id) {
      const n = nodes.get(id);
      if (n?.look == null || n.at === null) return undefined;
      return { x: n.at.x, y: n.at.y, w: n.look.w * n.at.k, h: TAG_H * n.at.k };
    },
  };
}
